// Flavor Intelligence browser fixtures: the page talks to the REAL atlas-ai
// handler and Tool Gateway (tests/node/helpers/atlas-ai-harness.mjs) running
// in Node against the VÁ evaluation world (tests/ai-evals/fixtures/world.mjs),
// so every flavour payload the browser sees has the exact engine shape
// (docs/flavor/Engine.md §7): flavor-map, flavor-search, flavor-substitutes,
// flavor-candidates, flavor-compose, execute-action and reject-action.
// Other atlas-ai actions (settings, conversations…) come from the standard
// Atlas AI mock. Recipes saved on approval appear in the page's recipes table.
//
// The world covers every stock state: verified in stock (gin, lemons, tonic…),
// verified zero (Aperol), never counted (Angostura, Kristall), stale (Kahlúa),
// a needs-review possible match (Cranberry Juice → strawberry) and ingredients
// with no Atlas item at all.
import * as realGateway from '../../supabase/functions/_shared/ai-tools/index.mjs';
import { clearFlavorSnapshotCache } from '../../supabase/functions/_shared/ai-tools/services.mjs';
import { createHandler, request, USERS as AI_USERS } from '../node/helpers/atlas-ai-harness.mjs';
import { createWorld, NOW } from '../ai-evals/fixtures/world.mjs';
import { atlasAiBackend } from './atlas-ai-fixtures.mjs';
import { emptyFunctions } from './fixtures.mjs';

const REAL_ACTIONS = new Set(['flavor-map', 'flavor-search', 'flavor-substitutes', 'flavor-candidates', 'flavor-compose', 'execute-action', 'reject-action']);

function aiUserFor(user) {
  if (user?.role === 'admin' || user?.role === 'manager') return AI_USERS.manager;
  if (user?.role === 'viewer') return AI_USERS.viewer;
  return AI_USERS.bartender;
}

/**
 * overrides: { [action]: (entry, backend) => harness result | undefined } —
 * answer an action yourself (for example a 429 or 503); undefined falls
 * through to the real handler.
 */
export function flavorBackend({ overrides = {} } = {}) {
  clearFlavorSnapshotCache();
  const world = createWorld();
  const harness = createHandler({ gateway: realGateway, env: { OPENAI_API_KEY: undefined }, fetchOptions: { fallback: world.fetch }, now: () => NOW });
  const mock = atlasAiBackend();
  const calls = [];

  async function handler(entry) {
    calls.push(entry);
    if (overrides[entry.action]) {
      const result = await overrides[entry.action](entry, backend);
      if (result !== undefined) return result;
    }
    if (!REAL_ACTIONS.has(entry.action)) return mock.handler(entry);
    const query = String(entry.search || '').replace(/^\?/, '').split('&').filter((part) => part && !part.startsWith('action=')).map((part) => `&${part}`).join('');
    const response = await harness.handle(request(entry.action, {
      method: entry.method,
      query,
      body: entry.method === 'GET' ? undefined : (entry.body ?? {}),
      user: aiUserFor(entry.user)
    }));
    const body = await response.json();
    if (response.status !== 200) return { __status: response.status, body };
    return body;
  }

  // The browser reads recipes and items from the same world, so a draft saved
  // on approval is in the list the page reloads.
  const tables = {
    recipes: () => world.data.recipes.map((recipe) => ({ yield_quantity: 1, yield_unit: 'serving', ...recipe })),
    recipe_catalog: () => world.data.recipes.filter((recipe) => recipe.active !== false).map(({ recipe_ingredients, ...recipe }) => ({ ...recipe, recipe_ingredients })),
    inventory_items: [],
    suppliers: [],
    recipe_categories: []
  };

  const backend = {
    world,
    harness,
    calls,
    handler,
    tables,
    writes: () => world.writes,
    fixtures: (extra = {}) => ({
      tables: { ...tables, ...(extra.tables || {}) },
      functions: { ...emptyFunctions(), ...(extra.functions || {}), 'atlas-ai': handler }
    })
  };
  return backend;
}

export const flavorCalls = (backend, action) => backend.calls.filter((entry) => entry.action === action);
