// Flavor Intelligence UI source contract: the Flavor Map and Create with Atlas
// (apps/web/assets/js/flavor-map.js), their styles in recipes.css, the
// #recipes/flavor route, the Recipes entry points and the recipe.draft
// approval card in Atlas AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(file, 'utf8');
const flavor = read('apps/web/assets/js/flavor-map.js');
const recipes = read('apps/web/assets/js/recipes.js');
const shell = read('apps/web/assets/js/atlas-shell.js');
const ai = read('apps/web/assets/js/atlas-ai.js');
const css = read('apps/web/assets/css/recipes.css');
const index = read('apps/web/index.html');

const flavorCss = css.slice(css.indexOf('  .flavor-page {')).replace(/\/\*[\s\S]*?\*\//g, '');

test('flavor-map.js loads right after recipes.js with the Flavor Intelligence key', () => {
  assert.ok(index.includes('<script src="assets/js/recipes.js?v=20261005-fi1"></script>\n<script src="assets/js/flavor-map.js?v=20261005-fi1"></script>'));
  assert.ok(index.includes('<link rel="stylesheet" href="assets/css/recipes.css?v=20261005-fi1">'));
  assert.equal(index.match(/flavor-map\.js/g).length, 1);
  assert.match(flavor, /window\.AtlasFlavorMap = Object\.freeze\(\{\s+mount,\s+unmount,\s+openCreate,/);
});

test('every call goes to the atlas-ai flavour routes through AtlasApi.request', () => {
  assert.match(flavor, /window\.AtlasApi\.request\(endpoint\(\), \{/);
  assert.match(flavor, /VABAR_CONFIG\?\.ATLAS_AI_API/);
  for (const action of ['flavor-map', 'flavor-search', 'flavor-substitutes', 'flavor-candidates', 'flavor-compose', 'execute-action', 'reject-action']) {
    assert.match(flavor, new RegExp(`api\\('${action}'`), action);
  }
  assert.doesNotMatch(flavor, /\bfetch\(|XMLHttpRequest|localStorage|sessionStorage/);
  // Approval uses the stored proposal id; nothing else writes.
  assert.match(flavor, /api\('execute-action', \{ body: \{ action_id: preview\.proposal\.id \}/);
  assert.doesNotMatch(flavor, /atlas_save_recipe|\bsb\.|atlasSupabase|\.rpc\(/);
});

test('nothing is saved without Approve: closing or discarding rejects the prepared draft', () => {
  assert.match(flavor, /function onCreateClosed\(\) \{[\s\S]*?if \(pending && !flow\.preview\.approved && !flow\.preview\.proposal\.spent && !flow\.approving && !flow\.preview\.outcomeUnknown\) rejectProposal\(pending\);/);
  assert.match(flavor, /async function discardDraft\(\) \{[\s\S]*?if \(flow\.busy\) return;[\s\S]*?if \(id && !spent && !unknown\) await rejectProposal\(id\);[\s\S]*?Nothing was saved\./);
  // An approval in flight or with an unknown outcome is never rejected, and
  // Approve waits for an unapplied rename.
  assert.match(flavor, /closeOnBackdrop: false/);
  assert.match(flavor, /event\.key === 'Escape' && flow\.busy && flow\.root/);
  assert.match(flavor, /flow\.root\.addEventListener\('keydown', holdEscapeWhileBusy\)/);
  assert.match(flavor, /preview\.outcomeUnknown = true;/);
  assert.match(flavor, /const blocked = Boolean\(flow\.nameError\) \|\| flow\.preview\.approved \|\| renamePending\(\);/);
  assert.match(flavor, /Saved as an inactive draft recipe — not on the menu\./);
  assert.match(flavor, /code === 'name_taken'/);
  // A stale idea (409) refreshes the ideas.
  assert.match(flavor, /error\?\.kind === 'conflict' \|\| error\?\.kind === 'not_found'/);
});

test('staff never get create actions or costs; economics only when the server sends them', () => {
  assert.match(flavor, /function canManage\(\) \{[\s\S]*?\['admin', 'manager'\]\.includes\(profile\.role\)/);
  assert.match(flavor, /manager \? `<button type="button" class="atlas-btn atlas-btn--primary atlas-btn--sm" data-flavor-create=/);
  assert.match(flavor, /if \(manager\) actions\.push\(\{ label: 'Create with Alcedo'/);
  assert.match(flavor, /const economy = economics \?/);
  assert.match(flavor, /const cost = manager && view\.totals\?\.estimated_total_label/);
  assert.match(flavor, /if \(step !== 'substitute' && !manager\)/);
  assert.match(recipes, /label: 'Create with Alcedo', icon: 'atlas-bot', variant: 'secondary', attrs: \{ 'data-recipe-create-atlas': '' \}/);
  assert.match(recipes, /: flavor \? \[\{ label: 'Flavor Map', icon: 'orbit', variant: 'secondary', attrs: \{ 'data-recipe-flavor-map': '' \} \}\] : \[\];/);
});

test('stock and evidence stay honest: unknown is not zero, possible matches never count, evidence types are separate', () => {
  assert.match(flavor, /available: \{ label: 'Verified in stock'/);
  assert.match(flavor, /out: \{ label: 'Not in stock'/);
  assert.match(flavor, /unknown: \{ label: 'Stock unknown'/);
  assert.match(flavor, /Unknown is not zero/);
  assert.match(flavor, /Possible match: \$\{escape\(item\.name\)\} <span class="recipe-muted">· needs review, not counted as stock/);
  for (const label of ["label: 'Culinary'", "label: 'Atlas-learned'", "label: 'Scientific'", "label: 'AI interpretation'"]) assert.ok(flavor.includes(label), label);
  // Each evidence entry is shown with its own label, never merged.
  assert.match(flavor, /const evidence = entries\.map\(\(entry\) => `<li class="flavor-detail__evidence">\$\{evidencePill\(entry\.evidence_type\)\}/);
  // A calculated substitute is never shown as a recorded one.
  assert.match(flavor, /row\.basis === 'recorded' \?/);
  assert.match(flavor, /Similar flavour profile, not a recorded substitute/);
});

test('filters come only from filters_available; unsupported ones are not rendered', () => {
  assert.match(flavor, /available\.uses\.includes\(key\)/);
  assert.match(flavor, /available\.evidence\.includes\(key\)/);
  assert.match(flavor, /if \(available\.in_stock_only === true\)/);
  assert.match(flavor, /if \(evidence\.length > 1\)/);
  assert.doesNotMatch(flavor, /use_soon|high_margin'\)|low_complexity|New ideas/);
});

test('accessibility and motion: buttons, list fallback, keyboard ring, reduced motion', () => {
  assert.match(flavor, /<button type="button" class="flavor-map__node/);
  assert.match(flavor, /<button type="button" class="flavor-map__row-main" data-flavor-select=/);
  assert.match(flavor, /aria-label="Centre the map on/);
  assert.match(flavor, /\['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'\]/);
  assert.match(flavor, /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches \|\| document\.documentElement\.classList\.contains\('atlas-reduce-motion'\)/);
  assert.match(flavorCss, /@media \(prefers-reduced-motion: reduce\) \{\s+\.flavor-map__node \{ animation: none; \}/);
  assert.match(flavorCss, /html\.atlas-reduce-motion \.flavor-map__node \{ animation: none; \}/);
  assert.match(flavorCss, /min-height: 44px;/);
  assert.match(flavorCss, /@media \(max-width: 767px\) \{\s+\.flavor-map, \.flavor-map--loading \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: "list" "detail" "stage";/);
  assert.match(flavorCss, /@media \(max-height: 560px\) and \(min-width: 768px\)/);
});

test('Flavor Map styles live in recipes.css, prefixed and on tokens only', () => {
  assert.ok(flavorCss.length > 2000);
  const selectors = [...flavorCss.matchAll(/(^|\})\s*([^{}@]+)\{/g)].map((match) => match[2].trim()).filter((selector) => selector && !/^(from|to)$/.test(selector));
  for (const selector of selectors) {
    for (const part of selector.split(',')) assert.match(part, /\.flavor-|\[data-stock=/, `unprefixed selector: ${part.trim()}`);
  }
  assert.doesNotMatch(flavorCss, /#[0-9a-fA-F]{3,8}\b|rgba?\(|!important|:root/);
});

test('copy has no engineering words, tool names or model names', () => {
  const literals = [...flavor.matchAll(/(['`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((match) => match[2]).join('\n');
  for (const word of ['JSON', 'payload', 'RPC', 'schema', 'runtime', 'OpenAI', 'gpt', 'Claude']) assert.doesNotMatch(literals, new RegExp(`\\b${word}\\b`, 'i'), word);
  for (const tool of ['flavor.pairings', 'flavor.candidates', 'recipes.compose_draft', 'flavor.substitutes']) assert.ok(!literals.includes(tool), tool);
});

test('#recipes/flavor is a route of Recipes, never a recipe id; Recipes hands the view to the map', () => {
  assert.match(shell, /if \(rest\[0\] === 'flavor'\) return \[\['recipes', section\('flavor', rest\[1\] \? \{ ingredient: rest\[1\] \} : \{\}\)\]\];/);
  assert.match(shell, /path = \['recipes', 'flavor', takeParam\(rest, 'ingredient'\)\];/);
  assert.match(recipes, /if \(params\.section === 'flavor' && window\.AtlasFlavorMap\) \{[\s\S]*?window\.AtlasFlavorMap\.mount\(dom\.view, \{ ingredient: params\.ingredient \|\| null \}\);/);
  assert.match(recipes, /if \(!dom\.view \|\| state\.flavor\) return;/);
  assert.match(recipes, /window\.AtlasFlavorMap\?\.unmount\?\.\(\);/);
});

test('Atlas AI approval card knows recipe.draft', () => {
  assert.match(ai, /'recipe\.draft': \{ icon: 'martini', verb: 'Save draft', done: 'Draft recipe saved', view: 'Open recipe', executable: true \}/);
  assert.match(ai, /code === 'name_taken' \? 'A recipe with this name already exists, so nothing was saved\./);
  assert.ok(index.includes('<script src="assets/js/atlas-ai.js?v=20261005-fi1"></script>'));
});
