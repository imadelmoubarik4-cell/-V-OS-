// Atlas Flavor Intelligence: the deterministic flavour engine.
//
// Pure, dependency-free ESM (no network, no clock, no randomness). Inputs:
//   snapshot       public.atlas_flavor_snapshot() (canonical ingredients,
//                  aliases, preparations, curated pairing edges, inventory
//                  links); see docs/flavor/Engine.md
//   projectedItems _shared/atlas-domain projectStock rows (services.projectedItems())
//   reportRows     _shared/stock-provenance buildStockReport rows (freshness labels)
//   recipes        existing Atlas recipes (co-occurrence, similarity, prices)
//
// Stock truth: an ingredient is available ONLY through a confirmed inventory
// link to an item whose projected stock is verified and current
// (atlas-domain isStockKnown, the same predicate inventory.current_stock uses
// via buildStockReport quantity_status 'current') with a quantity above zero.
// Unknown, stale, historical and raw imported quantities never count;
// `inventory_items.quantity` is never read. needs_review links are shown as
// possible matches and never count as stock.
//
// Evidence types stay distinct: scientific | culinary | atlas_learned |
// ai_interpretation. This engine never labels anything scientific itself;
// computed profile similarity is reported with basis 'profile' (a
// calculation over the curated vectors), never as a recorded pairing.

import { isStockKnown, recipeMetrics } from "../atlas-domain.mjs";
import { normalizeUnit, parsePackSize } from "../stock-provenance.mjs";
import { foldText } from "../product-identity.mjs";

export const FLAVOR_ENGINE_VERSION = "1.0.0";
export const EVIDENCE_TYPES = Object.freeze(["scientific", "culinary", "atlas_learned", "ai_interpretation"]);
export const RELATIONS = Object.freeze(["complement", "contrast", "bridge", "substitute"]);
export const TASTE_KEYS = Object.freeze(["sweet", "sour", "bitter", "salty", "umami", "fat", "alcohol", "astringency"]);
export const USES = Object.freeze(["cocktail", "mocktail", "coffee", "dessert", "food"]);
export const DRINK_TYPES = Object.freeze(["cocktail", "mocktail", "coffee"]);
export const CANDIDATE_TYPES = Object.freeze(["cocktail", "mocktail", "coffee", "dessert", "food"]);
export const GOALS = Object.freeze(["balanced", "use_stock", "low_cost", "high_margin", "novel", "simple"]);
export const STOCK_STATUSES = Object.freeze(["available", "out", "unknown", "not_stocked"]);

// Families whose products contain alcohol unless the snapshot says abv 0.
const ALCOHOLIC_FAMILIES = new Set(["spirit", "liqueur", "bitters", "wine_fortified", "beer_cider"]);
// Taste key aliases the seed data may use.
const TASTE_ALIASES = { fat: ["fat", "fat_rich"], alcohol: ["alcohol", "alcohol_heat"] };

export class FlavorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FlavorError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function str(value) {
  return String(value ?? "").trim();
}

function num(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

export function foldKey(value) {
  return foldText(String(value ?? "").replace(/[-_]+/g, " ")).replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function cosine(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const key of keys) {
    const x = num(a?.[key], 0);
    const y = num(b?.[key], 0);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Aroma profile similarity (cosine over aroma families), 0..1.
export function aromaSimilarity(a, b) {
  return round(cosine(a?.aroma, b?.aroma), 3) ?? 0;
}

// Taste profile similarity: 1 − mean absolute difference / 5, 0..1.
export function tasteSimilarity(a, b) {
  const diffs = TASTE_KEYS.map((key) => Math.abs(num(a?.taste?.[key], 0) - num(b?.taste?.[key], 0)));
  return round(1 - diffs.reduce((sum, value) => sum + value, 0) / (TASTE_KEYS.length * 5), 3);
}

// ---------------------------------------------------------------------------
// Snapshot index
// ---------------------------------------------------------------------------

function normalizeTaste(raw) {
  const taste = {};
  for (const key of TASTE_KEYS) {
    const names = TASTE_ALIASES[key] || [key];
    const value = names.map((name) => num(raw?.[name])).find((entry) => entry !== null);
    taste[key] = clamp(value ?? 0, 0, 5);
  }
  return taste;
}

function normalizeAroma(raw) {
  const aroma = {};
  for (const [key, value] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const parsed = num(value);
    if (parsed !== null && parsed > 0) aroma[key] = clamp(parsed, 0, 1);
  }
  return aroma;
}

function normalizeIngredient(row) {
  const abv = num(row.abv_typical);
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name) || str(row.slug),
    family: str(row.family).toLowerCase(),
    subfamily: str(row.subfamily).toLowerCase() || null,
    aroma: normalizeAroma(row.aroma),
    taste: normalizeTaste(row.taste),
    intensity: num(row.intensity),
    texture: str(row.texture).toLowerCase() || null,
    abv_typical: abv,
    allergens: arr(row.allergens).map(str).filter(Boolean),
    dietary: arr(row.dietary).map(str).filter(Boolean),
    uses: arr(row.uses).map((use) => str(use).toLowerCase()).filter(Boolean),
    techniques: arr(row.techniques).map(str).filter(Boolean),
    provider: row.provider ?? null,
    confidence: num(row.confidence),
  };
}

function normalizePreparation(row) {
  return {
    id: str(row.id),
    slug: str(row.slug),
    name: str(row.name) || str(row.slug),
    taste_shift: row.taste_shift && typeof row.taste_shift === "object" ? row.taste_shift : {},
    aroma_shift: row.aroma_shift && typeof row.aroma_shift === "object" ? row.aroma_shift : {},
    texture: str(row.texture).toLowerCase() || null,
  };
}

export function isAlcoholic(ingredient) {
  if (!ingredient) return false;
  if (ingredient.abv_typical !== null && ingredient.abv_typical !== undefined) return ingredient.abv_typical > 0;
  return ALCOHOLIC_FAMILIES.has(ingredient.family);
}

// Builds the lookup structures once per snapshot. Invalid rows are skipped.
export function indexSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const ingredients = arr(source.ingredients)
    .filter((row) => row && str(row.id) && str(row.slug))
    .map(normalizeIngredient)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const byId = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient]));
  const bySlug = new Map(ingredients.map((ingredient) => [ingredient.slug, ingredient]));

  const preparations = arr(source.preparations).filter((row) => row && str(row.id)).map(normalizePreparation);
  const prepById = new Map(preparations.map((prep) => [prep.id, prep]));
  const prepBySlug = new Map(preparations.map((prep) => [prep.slug, prep]));
  // Preparations may arrive as ids (preparation_id / a_prep) or slugs
  // (the snapshot's `preparation`, `a_prep`, `b_prep`): both resolve to the id.
  const prepIdOf = (value) => {
    const key = str(value);
    if (!key) return null;
    return prepById.get(key)?.id ?? prepBySlug.get(key)?.id ?? null;
  };
  const prepsByIngredient = new Map();
  for (const row of arr(source.ingredient_preparations)) {
    const ingredientId = str(row?.ingredient_id);
    const prep = prepById.get(prepIdOf(row?.preparation_id ?? row?.preparation));
    if (!byId.has(ingredientId) || !prep) continue;
    if (!prepsByIngredient.has(ingredientId)) prepsByIngredient.set(ingredientId, []);
    prepsByIngredient.get(ingredientId).push(prep);
  }

  // Search keys: name, slug and aliases, folded.
  const searchKeys = [];
  for (const ingredient of ingredients) {
    searchKeys.push({ key: foldKey(ingredient.name), ingredient_id: ingredient.id, label: ingredient.name, kind: "name" });
    searchKeys.push({ key: foldKey(ingredient.slug), ingredient_id: ingredient.id, label: ingredient.slug, kind: "slug" });
  }
  for (const row of arr(source.aliases)) {
    const ingredientId = str(row?.ingredient_id);
    if (!byId.has(ingredientId)) continue;
    const key = foldKey(row.alias_key || row.alias);
    if (key) searchKeys.push({ key, ingredient_id: ingredientId, label: str(row.alias) || key, kind: "alias", language: row.language ?? null });
  }

  const edges = [];
  const seenEdge = new Set();
  for (const row of arr(source.edges)) {
    const a = str(row?.a_id);
    const b = str(row?.b_id);
    if (!byId.has(a) || !byId.has(b) || a === b) continue;
    if (!RELATIONS.includes(row.relation) || !EVIDENCE_TYPES.includes(row.evidence_type)) continue;
    const id = str(row.id) || `${a}:${b}:${row.relation}:${row.evidence_type}`;
    if (seenEdge.has(id)) continue;
    seenEdge.add(id);
    edges.push({
      id,
      a_id: a,
      a_prep: prepIdOf(row.a_prep),
      b_id: b,
      b_prep: prepIdOf(row.b_prep),
      relation: row.relation,
      strength: clamp(num(row.strength, 0), 0, 1),
      aroma_score: num(row.aroma_score),
      taste_score: num(row.taste_score),
      texture_score: num(row.texture_score),
      evidence_type: row.evidence_type,
      provider: row.provider ?? null,
      confidence: num(row.confidence),
      explanation: str(row.explanation),
    });
  }

  const links = [];
  for (const row of arr(source.links)) {
    const ingredientId = str(row?.ingredient_id);
    const itemId = str(row?.inventory_item_id);
    if (!byId.has(ingredientId) || !itemId) continue;
    if (!["confirmed", "needs_review"].includes(row.status)) continue;
    links.push({
      inventory_item_id: itemId,
      ingredient_id: ingredientId,
      preparation_id: prepIdOf(row.preparation_id ?? row.preparation),
      status: row.status,
      match_method: row.match_method ?? null,
      confidence: num(row.confidence),
    });
  }
  const linksByIngredient = new Map();
  const linksByItem = new Map();
  for (const link of links) {
    if (!linksByIngredient.has(link.ingredient_id)) linksByIngredient.set(link.ingredient_id, []);
    linksByIngredient.get(link.ingredient_id).push(link);
    if (!linksByItem.has(link.inventory_item_id)) linksByItem.set(link.inventory_item_id, []);
    linksByItem.get(link.inventory_item_id).push(link);
  }

  const index = {
    version: source.version ?? null,
    sources: new Map(arr(source.sources).filter((row) => row && row.id).map((row) => [str(row.id), row])),
    ingredients, byId, bySlug, preparations, prepById, prepBySlug, prepsByIngredient, searchKeys,
    edges, links, linksByIngredient, linksByItem,
    adjacency: buildAdjacency(edges),
    learnedCache: new WeakMap(),
    edgeMemo: new Map(),
    recipeTokens: new WeakMap(),
    recipeTokenCounter: 0,
  };
  return index;
}

function buildAdjacency(edges) {
  const adjacency = new Map();
  const add = (self, other, selfPrep, otherPrep, edge) => {
    if (!adjacency.has(self)) adjacency.set(self, []);
    adjacency.get(self).push({ other, self_prep: selfPrep, other_prep: otherPrep, edge });
  };
  for (const edge of edges) {
    add(edge.a_id, edge.b_id, edge.a_prep, edge.b_prep, edge);
    add(edge.b_id, edge.a_id, edge.b_prep, edge.a_prep, edge);
  }
  return adjacency;
}

// Public view of an ingredient (no internals).
export function ingredientView(ingredient) {
  if (!ingredient) return null;
  return {
    id: ingredient.id,
    slug: ingredient.slug,
    name: ingredient.name,
    family: ingredient.family,
    subfamily: ingredient.subfamily,
    uses: [...ingredient.uses],
    intensity: ingredient.intensity,
    alcoholic: isAlcoholic(ingredient),
  };
}

export function preparationView(prep) {
  return prep ? { id: prep.id, slug: prep.slug, name: prep.name } : null;
}

// ---------------------------------------------------------------------------
// Search and resolution
// ---------------------------------------------------------------------------

function keyScore(entryKey, query, queryTokens) {
  if (entryKey === query) return { score: 1, match: "exact" };
  if (entryKey.startsWith(query) || entryKey.split(" ").some((token) => token === query)) return { score: 0.85, match: "prefix" };
  const entryTokens = entryKey.split(" ");
  if (queryTokens.every((token) => entryTokens.some((entry) => entry.startsWith(token)))) return { score: 0.7, match: "words" };
  const fuzzy = queryTokens.every((token) => {
    if (token.length < 4) return entryTokens.includes(token);
    const allowed = token.length >= 8 ? 2 : 1;
    return entryTokens.some((entry) => Math.abs(entry.length - token.length) <= allowed && levenshtein(entry, token) <= allowed);
  });
  return fuzzy ? { score: 0.5, match: "fuzzy" } : null;
}

// Ingredients matching free text (names, slugs, aliases; token and fuzzy
// matching). Returns [{ ingredient, score, match, via }], best first.
export function searchIngredients(index, query, { limit = 10, uses = null } = {}) {
  const needle = foldKey(query);
  if (!needle) return [];
  const queryTokens = needle.split(" ");
  const best = new Map();
  for (const entry of index.searchKeys) {
    const scored = keyScore(entry.key, needle, queryTokens);
    if (!scored) continue;
    const previous = best.get(entry.ingredient_id);
    if (!previous || scored.score > previous.score) {
      best.set(entry.ingredient_id, { ingredient: index.byId.get(entry.ingredient_id), score: scored.score, match: scored.match, via: entry.label, via_kind: entry.kind });
    }
  }
  return [...best.values()]
    .filter((result) => !uses || uses.some((use) => result.ingredient.uses.includes(use)))
    .sort((a, b) => b.score - a.score || a.ingredient.name.localeCompare(b.ingredient.name))
    .slice(0, Math.max(1, limit));
}

// Resolves a slug, id or name. Never guesses between several candidates.
// Returns { status: 'unique', ingredient } | { status: 'ambiguous', candidates } | { status: 'none' }.
export function resolveIngredient(index, ref) {
  const value = str(ref);
  if (!value) return { status: "none", candidates: [] };
  const direct = index.bySlug.get(value) || index.byId.get(value) || index.bySlug.get(foldKey(value).replace(/ /g, "-"));
  if (direct) return { status: "unique", ingredient: direct, candidates: [direct] };
  const results = searchIngredients(index, value, { limit: 6 });
  const exact = results.filter((result) => result.score === 1);
  if (exact.length === 1) return { status: "unique", ingredient: exact[0].ingredient, candidates: [exact[0].ingredient] };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((result) => result.ingredient) };
  if (results.length === 1 && results[0].score >= 0.5) return { status: "unique", ingredient: results[0].ingredient, candidates: [results[0].ingredient] };
  if (results.length > 1 && results[0].score >= 0.7 && results[1].score < results[0].score) {
    return { status: "unique", ingredient: results[0].ingredient, candidates: [results[0].ingredient] };
  }
  if (results.length) return { status: "ambiguous", candidates: results.map((result) => result.ingredient) };
  return { status: "none", candidates: [] };
}

// ---------------------------------------------------------------------------
// Stock (verified only)
// ---------------------------------------------------------------------------

// The single availability predicate: a projected item with a current
// verified quantity above zero (isStockKnown = freshness 'current' from
// currentQuantityEvidence, exactly what inventory.current_stock reports as
// quantity_status 'current'). Inactive items never count.
export function verifiedQuantity(item) {
  if (!item || item.active === false || !isStockKnown(item)) return null;
  return Number(item.verified_quantity);
}

export function isVerifiedAvailable(item) {
  const quantity = verifiedQuantity(item);
  return quantity !== null && quantity > 0;
}

function freshnessOf(item, reportRow) {
  if (!item) return "missing";
  if (item.active === false) return "inactive";
  if (isStockKnown(item)) return "current";
  const status = reportRow?.quantity_status;
  return ["stale", "historical", "unverified"].includes(status) ? status : "unknown";
}

// Per ingredient: { status, reason, items, possible_matches } from confirmed
// links over verified projected stock. Ingredients with no link are absent
// (stockFor reports them as not_stocked).
export function stockByIngredient(index, projectedItems, { reportRows = [] } = {}) {
  const items = new Map(arr(projectedItems).filter((item) => item && item.id !== undefined).map((item) => [str(item.id), item]));
  const reports = new Map(arr(reportRows).filter((row) => row && row.id !== undefined).map((row) => [str(row.id), row]));
  const result = new Map();
  for (const ingredient of index.ingredients) {
    const links = index.linksByIngredient.get(ingredient.id) || [];
    if (!links.length) continue;
    const confirmed = [];
    const possible = [];
    for (const link of links) {
      const item = items.get(link.inventory_item_id);
      if (!item) continue;
      const quantity = verifiedQuantity(item);
      const prep = link.preparation_id ? index.prepById.get(link.preparation_id) || null : null;
      const view = {
        item_id: str(item.id),
        name: str(item.name),
        unit: item.unit ?? null,
        verified_quantity: quantity,
        freshness: freshnessOf(item, reports.get(str(item.id))),
        available: link.status === "confirmed" && quantity !== null && quantity > 0,
        link_status: link.status,
        preparation: preparationView(prep),
        match_method: link.match_method,
        link_confidence: link.confidence,
        par_level: num(item.par_level),
      };
      (link.status === "confirmed" ? confirmed : possible).push(view);
    }
    if (!confirmed.length && !possible.length) continue;
    const sortItems = (list) => list.sort((a, b) => Number(b.available) - Number(a.available)
      || (b.verified_quantity ?? -1) - (a.verified_quantity ?? -1) || a.name.localeCompare(b.name));
    sortItems(confirmed);
    sortItems(possible);
    let status;
    let reason;
    if (confirmed.some((entry) => entry.available)) {
      status = "available";
      reason = "verified current count above zero";
    } else if (confirmed.some((entry) => entry.verified_quantity !== null)) {
      status = "out";
      reason = "verified count at zero";
    } else if (confirmed.length) {
      status = "unknown";
      reason = "no current verified count";
    } else {
      status = "unknown";
      reason = "only a possible match that needs review";
    }
    result.set(ingredient.id, { ingredient_id: ingredient.id, slug: ingredient.slug, name: ingredient.name, status, reason, items: confirmed, possible_matches: possible });
  }
  return result;
}

export function stockFor(stock, ingredientId) {
  return stock?.get?.(ingredientId) || { ingredient_id: ingredientId, status: "not_stocked", reason: "not linked to any Atlas inventory item", items: [], possible_matches: [] };
}

// ---------------------------------------------------------------------------
// Atlas-learned co-occurrence and pairings
// ---------------------------------------------------------------------------

function ingredientIdsOfRecipe(index, recipe) {
  const ids = new Set();
  for (const line of arr(recipe?.recipe_ingredients)) {
    for (const link of index.linksByItem.get(str(line?.item_id)) || []) {
      if (link.status === "confirmed") ids.add(link.ingredient_id);
    }
  }
  return ids;
}

// Pairs used together in active Atlas recipes (confirmed links only).
export function learnedEdges(index, recipes) {
  const list = arr(recipes);
  if (index.learnedCache.has(list)) return index.learnedCache.get(list);
  const pairs = new Map();
  for (const recipe of list) {
    if (!recipe || recipe.active === false) continue;
    const ids = [...ingredientIdsOfRecipe(index, recipe)].sort();
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = `${ids[i]}|${ids[j]}`;
        if (!pairs.has(key)) pairs.set(key, { a: ids[i], b: ids[j], recipes: [] });
        pairs.get(key).recipes.push({ id: str(recipe.id), name: str(recipe.name) });
      }
    }
  }
  const edges = [...pairs.values()].map(({ a, b, recipes: used }) => {
    const count = used.length;
    const names = used.map((recipe) => recipe.name).sort();
    return {
      id: `learned:${a}:${b}`,
      a_id: a, a_prep: null, b_id: b, b_prep: null,
      relation: "complement",
      strength: round(Math.min(0.9, 0.45 + 0.15 * count), 2),
      aroma_score: null, taste_score: null, texture_score: null,
      evidence_type: "atlas_learned",
      provider: "atlas_recipes",
      confidence: round(Math.min(0.9, 0.5 + 0.1 * count), 2),
      explanation: `Used together in ${count} Atlas recipe${count === 1 ? "" : "s"}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? "…" : ""}.`,
      recipes: used,
    };
  });
  const result = { edges, adjacency: buildAdjacency(edges) };
  index.learnedCache.set(list, result);
  return result;
}

// Every edge touching an ingredient (curated + learned when recipes given).
export function edgesOf(index, ingredientId, recipes = null) {
  const curated = index.adjacency.get(ingredientId) || [];
  if (!recipes) return curated;
  const learned = learnedEdges(index, recipes).adjacency.get(ingredientId) || [];
  return [...curated, ...learned];
}

function edgeView(entry) {
  const { edge } = entry;
  return {
    relation: edge.relation,
    strength: edge.strength,
    evidence_type: edge.evidence_type,
    provider: edge.provider,
    confidence: edge.confidence,
    explanation: edge.explanation,
    ...(edge.recipes ? { recipes: edge.recipes.map((recipe) => recipe.name) } : {}),
  };
}

// The best recorded link between two ingredients (curated or learned), or null.
export function bestEdge(index, aId, bId, recipes = null) {
  const memoKey = `${recipes ? memoToken(index, recipes) : 0}|${aId}|${bId}`;
  if (index.edgeMemo.has(memoKey)) return index.edgeMemo.get(memoKey);
  const found = bestEdgeUncached(index, aId, bId, recipes);
  index.edgeMemo.set(memoKey, found);
  return found;
}

function memoToken(index, recipes) {
  if (!index.recipeTokens.has(recipes)) {
    index.recipeTokenCounter += 1;
    index.recipeTokens.set(recipes, index.recipeTokenCounter);
    // One memo generation per recipe list: drop entries of older lists.
    if (index.edgeMemo.size > 50000) index.edgeMemo.clear();
  }
  return index.recipeTokens.get(recipes);
}

function bestEdgeUncached(index, aId, bId, recipes) {
  const entries = edgesOf(index, aId, recipes).filter((entry) => entry.other === bId && entry.edge.relation !== "substitute");
  if (!entries.length) return null;
  return entries.sort((x, y) => y.edge.strength - x.edge.strength || evidenceRank(x.edge) - evidenceRank(y.edge))[0];
}

function evidenceRank(edge) {
  return { culinary: 0, scientific: 1, atlas_learned: 2, ai_interpretation: 3 }[edge.evidence_type] ?? 4;
}

// Neighbours of an ingredient with every dimension exposed.
export function pairings(index, ref, { prep = null, filters = {}, limit = 24, stock = null, recipes = null } = {}) {
  const center = typeof ref === "object" ? ref : (index.bySlug.get(ref) || index.byId.get(ref));
  if (!center) throw new FlavorError("not_found", "That ingredient is not in the flavour library.");
  const prepObject = prep ? (index.prepBySlug.get(prep) || index.prepById.get(prep) || null) : null;
  if (prep && !prepObject) throw new FlavorError("not_found", "That preparation is not in the flavour library.");
  const evidence = arr(filters.evidence).filter((type) => EVIDENCE_TYPES.includes(type));
  const grouped = new Map();
  for (const entry of edgesOf(index, center.id, recipes)) {
    if (entry.edge.relation === "substitute" && !filters.include_substitutes) continue;
    if (prepObject && entry.self_prep && entry.self_prep !== prepObject.id) continue;
    if (evidence.length && !evidence.includes(entry.edge.evidence_type)) continue;
    if (filters.relation && entry.edge.relation !== filters.relation) continue;
    const other = index.byId.get(entry.other);
    if (!other) continue;
    if (filters.use && !other.uses.includes(filters.use)) continue;
    const status = stock ? stockFor(stock, other.id).status : null;
    if (filters.in_stock_only && status !== "available") continue;
    if (!grouped.has(other.id)) grouped.set(other.id, { other, status, entries: [] });
    grouped.get(other.id).entries.push(entry);
  }
  const neighbours = [...grouped.values()].map(({ other, status, entries }) => {
    entries.sort((x, y) => y.edge.strength - x.edge.strength || evidenceRank(x.edge) - evidenceRank(y.edge));
    const top = entries[0].edge;
    const curated = entries.find((entry) => entry.edge.evidence_type !== "atlas_learned")?.edge ?? null;
    const recordedAroma = curated?.aroma_score ?? null;
    const recordedTaste = curated?.taste_score ?? null;
    return {
      ingredient: ingredientView(other),
      other_preparation: preparationView(index.prepById.get(entries[0].other_prep) || null),
      relation: top.relation,
      dims: {
        strength: top.strength,
        aroma: recordedAroma ?? aromaSimilarity(center, other),
        taste: recordedTaste ?? tasteSimilarity(center, other),
        texture: curated?.texture_score ?? null,
      },
      dims_basis: {
        aroma: recordedAroma !== null ? "recorded" : "profile",
        taste: recordedTaste !== null ? "recorded" : "profile",
        texture: curated?.texture_score !== null && curated?.texture_score !== undefined ? "recorded" : "not recorded",
      },
      evidence_type: top.evidence_type,
      confidence: top.confidence,
      explanation: top.explanation,
      provider: top.provider,
      evidence: entries.map(edgeView),
      stock_status: status,
      in_stock: status === "available",
    };
  }).sort((a, b) => b.dims.strength - a.dims.strength || (b.confidence ?? 0) - (a.confidence ?? 0) || a.ingredient.name.localeCompare(b.ingredient.name));
  return {
    center: ingredientView(center),
    preparation: preparationView(prepObject),
    neighbours: neighbours.slice(0, Math.max(1, limit)),
    total: neighbours.length,
  };
}

function tasteDifferences(original, candidate) {
  const notes = [];
  for (const key of ["sweet", "sour", "bitter", "fat", "alcohol"]) {
    const delta = num(candidate.taste[key], 0) - num(original.taste[key], 0);
    if (Math.abs(delta) < 1.5) continue;
    const word = { sweet: "sweeter", sour: "more sour", bitter: "more bitter", fat: "richer", alcohol: "stronger" }[key];
    const opposite = { sweet: "less sweet", sour: "less sour", bitter: "less bitter", fat: "lighter", alcohol: "less alcoholic" }[key];
    notes.push({ key, delta: round(delta, 1), text: delta > 0 ? word : opposite });
  }
  return notes;
}

function adjustmentHint(differences) {
  const hints = [];
  for (const difference of differences) {
    if (difference.key === "sour" && difference.delta < 0) hints.push("add a little fresh citrus to restore acidity");
    if (difference.key === "sour" && difference.delta > 0) hints.push("reduce the citrus or add a touch more syrup");
    if (difference.key === "sweet" && difference.delta > 0) hints.push("reduce the syrup");
    if (difference.key === "sweet" && difference.delta < 0) hints.push("add a little syrup");
    if (difference.key === "alcohol" && difference.delta > 0) hints.push("the swap adds alcohol; not for zero-proof drinks");
  }
  return hints;
}

// Substitutes: recorded substitute edges first, then same-family profile
// matches (computed, labelled basis 'profile').
export function substitutes(index, ref, { stock = null, in_stock_only = false, limit = 8 } = {}) {
  const original = typeof ref === "object" ? ref : (index.bySlug.get(ref) || index.byId.get(ref));
  if (!original) throw new FlavorError("not_found", "That ingredient is not in the flavour library.");
  const found = new Map();
  for (const entry of index.adjacency.get(original.id) || []) {
    if (entry.edge.relation !== "substitute") continue;
    const other = index.byId.get(entry.other);
    if (!other) continue;
    const previous = found.get(other.id);
    if (previous && previous.score >= entry.edge.strength) continue;
    found.set(other.id, {
      other,
      score: entry.edge.strength,
      basis: "recorded",
      evidence_type: entry.edge.evidence_type,
      provider: entry.edge.provider,
      confidence: entry.edge.confidence,
      explanation: entry.edge.explanation,
    });
  }
  for (const other of index.ingredients) {
    if (other.id === original.id || found.has(other.id)) continue;
    if (other.family !== original.family) continue;
    if (isAlcoholic(other) !== isAlcoholic(original)) continue;
    const aroma = aromaSimilarity(original, other);
    const taste = tasteSimilarity(original, other);
    if (aroma < 0.5) continue;
    const sameSub = other.subfamily && other.subfamily === original.subfamily;
    const score = round((0.6 * aroma + 0.4 * taste) * (sameSub ? 1 : 0.8), 3);
    if (score < 0.5) continue;
    found.set(other.id, {
      other,
      score,
      basis: "profile",
      evidence_type: null,
      provider: null,
      confidence: null,
      explanation: `Same family (${original.family}${sameSub ? `, ${original.subfamily}` : ""}) with a similar aroma profile (${round(aroma * 100, 0)}% overlap). Calculated from the flavour profiles, not a recorded pairing.`,
    });
  }
  const rows = [...found.values()].map((entry) => {
    const status = stock ? stockFor(stock, entry.other.id).status : null;
    const differences = tasteDifferences(original, entry.other);
    return {
      ingredient: ingredientView(entry.other),
      score: entry.score,
      basis: entry.basis,
      evidence_type: entry.evidence_type,
      provider: entry.provider,
      confidence: entry.confidence,
      explanation: entry.explanation,
      aroma_similarity: aromaSimilarity(original, entry.other),
      taste_similarity: tasteSimilarity(original, entry.other),
      differences: differences.map((difference) => difference.text),
      adjustments: adjustmentHint(differences),
      stock_status: status,
      in_stock: status === "available",
    };
  })
    .filter((row) => !in_stock_only || row.in_stock)
    .sort((a, b) => Number(b.basis === "recorded") - Number(a.basis === "recorded") || b.score - a.score || a.ingredient.name.localeCompare(b.ingredient.name));
  return { original: ingredientView(original), substitutes: rows.slice(0, Math.max(1, limit)), total: rows.length };
}

// ---------------------------------------------------------------------------
// Candidate options (ingredient × preparation × verified items)
// ---------------------------------------------------------------------------

function effectiveTaste(ingredient, prep) {
  const taste = { ...ingredient.taste };
  for (const [key, value] of Object.entries(prep?.taste_shift || {})) {
    const target = TASTE_KEYS.find((name) => name === key || (TASTE_ALIASES[name] || []).includes(key));
    if (target) taste[target] = clamp(num(taste[target], 0) + num(value, 0), 0, 5);
  }
  return taste;
}

function excludedBy(ingredient, exclude) {
  const families = arr(exclude?.families).map((family) => str(family).toLowerCase());
  const ids = new Set(arr(exclude?.ingredient_ids).map(str));
  if (ids.has(ingredient.id)) return true;
  // "No citrus" also excludes citrus-led products (orange liqueur, orange bitters).
  return families.some((family) => ingredient.family === family || (ingredient.subfamily || "").split("_").includes(family) || (ingredient.subfamily || "") === family);
}

// Options a template role can use. Available options carry the verified
// items; to_buy options exist only when new purchases are allowed.
export function buildOptions(index, stock, { noNewPurchases = true, exclude = null } = {}) {
  const options = [];
  for (const ingredient of index.ingredients) {
    if (excludedBy(ingredient, exclude)) continue;
    const entry = stockFor(stock, ingredient.id);
    const groups = new Map();
    for (const item of entry.items.filter((candidate) => candidate.available)) {
      const prepId = item.preparation?.id ?? null;
      if (!groups.has(prepId)) groups.set(prepId, []);
      groups.get(prepId).push(item);
    }
    for (const [prepId, items] of groups) {
      const prep = prepId ? index.prepById.get(prepId) || null : null;
      options.push(makeOption(ingredient, prep, items, "available"));
    }
    if (!noNewPurchases && !groups.has(null)) options.push(makeOption(ingredient, null, [], "to_buy"));
  }
  return options.sort((a, b) => a.key.localeCompare(b.key));
}

function makeOption(ingredient, prep, items, status) {
  return {
    key: `${ingredient.slug}~${prep?.slug ?? "-"}~${status}`,
    ingredient,
    prep,
    items,
    status,
    taste: effectiveTaste(ingredient, prep),
    alcoholic: isAlcoholic(ingredient),
    texture: prep?.texture || ingredient.texture,
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const isSweetPrep = (option) => ["syrup", "cordial", "shrub", "oleo-saccharum", "honey-syrup"].includes(option.prep?.slug);
const isSolidSugar = (option) => option.ingredient.family === "sweetener" && option.ingredient.subfamily === "sugar" && !isSweetPrep(option);
const SELECT = {
  spirit: (o) => o.ingredient.family === "spirit",
  sour: (o) => o.taste.sour >= 4 && ["citrus", "fruit"].includes(o.ingredient.family) && !o.alcoholic && !isSweetPrep(o),
  sweet: (o) => o.taste.sweet >= 3.5 && !isSolidSugar(o) && (o.ingredient.family === "sweetener" || isSweetPrep(o) || o.ingredient.family === "liqueur"),
  sweet_nonalc: (o) => !o.alcoholic && o.taste.sweet >= 3.5 && !isSolidSugar(o) && (o.ingredient.family === "sweetener" || isSweetPrep(o)),
  bitters: (o) => o.ingredient.family === "bitters",
  top: (o) => o.ingredient.family === "mixer" && !o.alcoholic && (o.ingredient.subfamily === "carbonated" || o.texture === "carbonated"),
  sparkling: (o) => o.ingredient.family === "wine_fortified" && o.ingredient.subfamily === "sparkling",
  modifier: (o) => (o.ingredient.family === "liqueur" || (o.ingredient.family === "wine_fortified" && o.ingredient.subfamily !== "sparkling")),
  aged_spirit: (o) => o.ingredient.family === "spirit" && ["grape_brandy", "whiskey", "rum", "agave", "fruit_brandy", "cane"].includes(o.ingredient.subfamily),
  sweet_plain: (o) => o.taste.sweet >= 3.5 && (o.ingredient.family === "sweetener" || isSweetPrep(o)),
  aperitif: (o) => o.ingredient.family === "liqueur" || (o.ingredient.family === "wine_fortified" && o.ingredient.subfamily === "vermouth"),
  coffee: (o) => o.ingredient.family === "coffee",
  milk: (o) => ["dairy", "dairy_alternative"].includes(o.ingredient.family),
  flavour_nonalc: (o) => !o.alcoholic && ((isSweetPrep(o) && ["fruit", "flower", "herb", "spice", "citrus"].includes(o.ingredient.family))
    || (["fruit"].includes(o.ingredient.family) && o.taste.sweet >= 2.5)),
  fruit_nonalc: (o) => !o.alcoholic && o.ingredient.family === "fruit" && !isSweetPrep(o),
  garnish: (o) => ["herb", "citrus"].includes(o.ingredient.family),
  dessert_base: (o) => o.ingredient.uses.includes("dessert") && ["chocolate", "fruit", "dairy", "nut", "confection"].includes(o.ingredient.family),
  dessert_accent: (o) => o.ingredient.uses.includes("dessert") && ["fruit", "flower", "spice", "herb", "citrus", "coffee"].includes(o.ingredient.family),
  dessert_sauce: (o) => o.ingredient.uses.includes("dessert") && (o.ingredient.family === "liqueur" || o.ingredient.family === "sweetener" || isSweetPrep(o)),
  food_main: (o) => o.ingredient.uses.includes("food") && !["spirit", "liqueur", "bitters", "mixer"].includes(o.ingredient.family),
  food_accent: (o) => o.ingredient.uses.includes("food") && ["herb", "citrus", "spice", "fruit", "seasoning"].includes(o.ingredient.family),
};

// Role: key, select, amount (ml of liquid, or a coffee shot), required.
const R = (role, select, ml, required = true, extra = {}) => ({ role, select, ml, required, ...extra });

export const TEMPLATES = Object.freeze([
  {
    key: "sour", name: "Sour", types: ["cocktail"], glass: "Coupe", technique: "shaken", dilution: 0.22, balance: "sour_ratio", texture: "silky",
    equipment: ["shaker", "jigger", "hawthorne strainer", "fine strainer"], batching: "partial",
    roles: [R("base", "spirit", 50), R("sour", "sour", 25), R("sweet", "sweet", 20), R("accent", "bitters", 1, false)],
    method: ["Chill a coupe.", "Add {base}, {sour} and {sweet}{accent} to a shaker.", "Shake hard with cubed ice for 10–12 seconds.", "Double strain into the chilled coupe.", "Garnish with {garnish}."],
  },
  {
    key: "collins", name: "Collins", types: ["cocktail"], glass: "Collins", technique: "shaken and topped", dilution: 0.15, balance: "sour_ratio", texture: "carbonated",
    equipment: ["shaker", "jigger", "hawthorne strainer"], batching: "partial",
    roles: [R("base", "spirit", 45), R("sour", "sour", 25), R("sweet", "sweet", 15), R("top", "top", 60)],
    method: ["Fill a Collins glass with cubed ice.", "Shake {base}, {sour} and {sweet} with ice.", "Strain into the glass and top with {top}.", "Garnish with {garnish}."],
  },
  {
    key: "highball", name: "Highball", types: ["cocktail"], glass: "Highball", technique: "built", dilution: 0.1, balance: "light", texture: "carbonated",
    equipment: ["jigger", "bar spoon"], batching: "partial",
    roles: [R("base", "spirit", 45), R("top", "top", 120), R("accent", "sour", 10, false)],
    method: ["Fill a highball glass with cubed ice.", "Add {base}{accent}.", "Top with {top} and lift once with a bar spoon.", "Garnish with {garnish}."],
  },
  {
    key: "stirred", name: "Stirred", types: ["cocktail"], glass: "Nick & Nora", technique: "stirred", dilution: 0.2, balance: "bittersweet", texture: "silky",
    equipment: ["mixing glass", "bar spoon", "jigger", "julep strainer"], batching: "batchable",
    roles: [R("base", "spirit", 45), R("modifier", "modifier", 25), R("bitters", "bitters", 1, false)],
    method: ["Add {base} and {modifier}{bitters} to a mixing glass.", "Stir with cubed ice for 20–25 seconds until well chilled.", "Strain into a chilled Nick & Nora glass.", "Garnish with {garnish}."],
  },
  {
    key: "old_fashioned", name: "Old Fashioned", types: ["cocktail"], glass: "Rocks", technique: "stirred", dilution: 0.2, balance: "bittersweet", texture: "silky",
    equipment: ["mixing glass", "bar spoon", "jigger", "julep strainer"], batching: "batchable",
    roles: [R("base", "aged_spirit", 50), R("sweet", "sweet_plain", 7.5), R("bitters", "bitters", 1.5)],
    method: ["Add {base}, {sweet} and {bitters} to a mixing glass.", "Stir with cubed ice for 20–25 seconds.", "Strain over a large ice cube in a rocks glass.", "Garnish with {garnish}."],
  },
  {
    key: "spritz", name: "Spritz", types: ["cocktail"], glass: "Wine glass", technique: "built", dilution: 0.08, balance: "light", texture: "carbonated",
    equipment: ["jigger", "bar spoon"], batching: "partial",
    roles: [R("aperitif", "aperitif", 50), R("sparkling", "sparkling", 75), R("top", "top", 25)],
    method: ["Fill a wine glass with cubed ice.", "Add {aperitif} and {sparkling}.", "Top with {top} and stir gently once.", "Garnish with {garnish}."],
  },
  {
    key: "coffee_cocktail", name: "Coffee cocktail", types: ["cocktail", "coffee"], glass: "Coupe", technique: "shaken", dilution: 0.2, balance: "coffee", texture: "foamy", garnishFamilies: [],
    equipment: ["espresso machine", "shaker", "jigger", "fine strainer"], batching: "not_batchable",
    roles: [R("base", "spirit", 40), R("coffee", "coffee", 30, true, { shot: true }), R("sweet", "sweet", 20), R("cream", "milk", 15, false)],
    method: ["Pull a fresh espresso: {coffee}.", "Shake {base}, the espresso and {sweet}{cream} hard with cubed ice.", "Fine strain into a chilled coupe for a thick crema.", "Garnish with {garnish}."],
  },
  {
    key: "cordial_soda", name: "Cordial & soda", types: ["mocktail"], glass: "Highball", technique: "built", dilution: 0.1, balance: "light", texture: "carbonated", alcoholFree: true,
    equipment: ["jigger", "bar spoon"], batching: "partial",
    roles: [R("flavour", "flavour_nonalc", 30), R("top", "top", 120), R("sour", "sour", 10, false)],
    method: ["Fill a highball glass with cubed ice.", "Add {flavour}{sour}.", "Top with {top} and lift once with a bar spoon.", "Garnish with {garnish}."],
  },
  {
    key: "zero_sour", name: "Zero-proof sour", types: ["mocktail"], glass: "Coupe", technique: "shaken", dilution: 0.2, balance: "sour_ratio", texture: "silky", alcoholFree: true,
    equipment: ["shaker", "jigger", "fine strainer"], batching: "partial",
    roles: [R("fruit", "fruit_nonalc", 45), R("sour", "sour", 25), R("sweet", "sweet_nonalc", 15)],
    method: ["Chill a coupe.", "Shake {fruit}, {sour} and {sweet} hard with cubed ice.", "Double strain into the chilled coupe.", "Garnish with {garnish}."],
  },
  {
    key: "iced_latte", name: "Iced latte", types: ["coffee"], glass: "Tumbler", technique: "built", dilution: 0.1, balance: "coffee", texture: "creamy", alcoholFree: true, garnishFamilies: [],
    equipment: ["espresso machine", "jigger"], batching: "not_batchable",
    roles: [R("coffee", "coffee", 30, true, { shot: true }), R("milk", "milk", 150), R("flavour", "sweet_nonalc", 15)],
    method: ["Pull a fresh espresso: {coffee}.", "Fill a tumbler with ice and add {flavour}.", "Pour over {milk}, then float the espresso on top.", "Garnish with {garnish}."],
  },
  {
    key: "dessert_pairing", name: "Dessert pairing", types: ["dessert"], composable: false, balance: "none", texture: "any",
    equipment: [], batching: "n/a", glass: null, technique: "pairing", dilution: 0,
    roles: [R("base", "dessert_base", 0), R("accent", "dessert_accent", 0), R("sauce", "dessert_sauce", 0, false)],
    method: [],
  },
  {
    key: "food_pairing", name: "Food pairing", types: ["food"], composable: false, balance: "none", texture: "any",
    equipment: [], batching: "n/a", glass: null, technique: "pairing", dilution: 0,
    roles: [R("main", "food_main", 0), R("accent", "food_accent", 0)],
    method: [],
  },
]);

const SOUR_TEMPLATES = new Set(["sour", "collins", "zero_sour"]);
const TEMPLATE_BY_KEY = new Map(TEMPLATES.map((template) => [template.key, template]));
const TYPE_LABEL = { cocktail: "Cocktail", mocktail: "Mocktail", coffee: "Coffee", dessert: "Dessert", food: "Food" };
// The recipe type a draft is saved with: an existing Recipes category slug
// (recipes.type), so it lands in the right category and its edit form keeps it.
const DRAFT_TYPE = { cocktail: "signature-cocktail", mocktail: "mocktail", coffee: "coffee" };

function templatesFor(type) {
  return TEMPLATES.filter((template) => template.types.includes(type));
}

function optionFits(template, role, option) {
  if (!SELECT[role.select]?.(option)) return false;
  if (template.alcoholFree && option.alcoholic) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Quantities: template millilitres → the chosen item's own unit
// ---------------------------------------------------------------------------

const JUICE_PER_EACH_ML = { citrus: 30, fruit: 50 };
const SHOT_GRAMS = 18;

function itemBase(item) {
  const pack = parsePackSize(item);
  if (pack && ["ml", "g"].includes(pack.unit)) return pack.unit;
  const unit = normalizeUnit(item?.unit);
  if (unit === "untracked") return null;
  return unit || null;
}

// Converts one role amount into a recipe line for this item, or null when the
// item's unit cannot express it (the option is then skipped, never guessed).
// Packs of juice, purée or syrup are never garnish and never "whole fruit".
const PROCESSED_NAME = /juice|safi|pur[ée]e|syrup|sír[óo]p|cordial|concentrate|nectar|mix/i;
const PRODUCE_FAMILIES = new Set(["fruit", "citrus", "herb", "vegetable", "spice", "flower"]);

function lineFor(role, option, item, templateKey) {
  const garnish = role.role === "garnish";
  const base = item ? itemBase(item) : "ml";
  const wholeProduce = PRODUCE_FAMILIES.has(option.ingredient.family) && (!option.prep || ["peel", "zest"].includes(option.prep.slug))
    && !(item && PROCESSED_NAME.test(str(item.name)));
  // Raw produce by weight cannot fill a liquid role (it needs juicing, a purée or a syrup first).
  if (!garnish && !role.shot && base === "g" && PRODUCE_FAMILIES.has(option.ingredient.family) && !option.prep) return null;
  if (garnish && !wholeProduce) return null;
  let quantity;
  let unit;
  let kind = "plain";
  let volume = garnish ? 0 : role.ml;
  if (role.shot) {
    kind = "shot";
    volume = 30;
    if (base === "g") { quantity = SHOT_GRAMS; unit = "g"; } else if (base === "ml") { quantity = 30; unit = "ml"; } else return null;
  } else if (garnish) {
    if (!item || !["each", "bunch"].includes(base)) return null;
    kind = "garnish";
    quantity = option.ingredient.family === "citrus" ? 0.125 : 0.05;
    unit = base;
  } else if (base === "ml" || base === "g") {
    // Syrups, purées and milk measured by weight: 1 ml is taken as 1 g.
    quantity = role.ml;
    unit = base;
  } else if (item && base === "each" && JUICE_PER_EACH_ML[option.ingredient.family] && wholeProduce) {
    kind = "juice";
    quantity = Math.max(0.25, roundTo(role.ml / JUICE_PER_EACH_ML[option.ingredient.family], 0.25));
    unit = "each";
  } else {
    return null;
  }
  if (role.select === "bitters") kind = "bitters";
  const line = {
    role: role.role,
    kind,
    ingredient_id: option.ingredient.id,
    ingredient_slug: option.ingredient.slug,
    ingredient_name: option.ingredient.name,
    preparation: option.prep?.slug ?? null,
    item_id: item ? str(item.id) : null,
    item_name: item ? str(item.name) : option.ingredient.name,
    quantity: round(quantity, 3),
    unit,
    volume_ml: volume,
    to_buy: !item,
    template: templateKey,
  };
  line.display = labelOf(line);
  return line;
}

function formatAmount(line) {
  const value = Number.isInteger(line.quantity) ? line.quantity : round(line.quantity, 2);
  return `${value} ${line.unit}`;
}

// Human wording for one line (method text and preview).
export function labelOf(line) {
  const name = line.item_name;
  switch (line.kind) {
    case "shot": return `1 espresso shot (${formatAmount(line)} ${name})`;
    case "bitters": return `${line.quantity <= 1 ? 2 : 3} dashes of ${name} (${formatAmount(line)})`;
    case "juice": return `${line.volume_ml} ml fresh juice from ${name} (about ${formatAmount(line)})`;
    case "garnish": return `${line.ingredient_name.toLowerCase()} ${line.ingredient_slug.includes("mint") || line.ingredient_slug.includes("basil") ? "sprig" : "peel"} (${name})`;
    default: return `${formatAmount(line)} ${name}${line.to_buy ? " (to buy)" : ""}`;
  }
}

function syntheticRecipe(lines, { name = "Atlas draft", menuPrice = null } = {}) {
  return {
    id: "atlas-flavor-draft",
    name,
    active: true,
    yield_quantity: 1,
    menu_price: menuPrice,
    recipe_ingredients: lines.filter((line) => line.item_id).map((line) => ({
      item_id: line.item_id, item_name: line.item_name, quantity: line.quantity, unit: line.unit,
    })),
  };
}

// Picks the first verified item (most stock first) whose unit can express
// the line and whose verified stock covers at least one serve (canonical
// recipeMetrics batches ≥ 1). Returns { line, item, servings } or null.
function pickItem(role, option, itemsById, templateKey) {
  if (option.status === "to_buy") {
    const line = lineFor(role, option, null, templateKey);
    return line ? { line, item: null, servings: null } : null;
  }
  for (const stockItem of option.items) {
    const item = itemsById.get(stockItem.item_id);
    if (!item || !isVerifiedAvailable(item)) continue;
    const line = lineFor(role, option, item, templateKey);
    if (!line) continue;
    const metrics = recipeMetrics(syntheticRecipe([line]), [item]);
    const batches = metrics.rows[0]?.batches;
    if (!Number.isFinite(batches) || batches < 1) continue;
    return { line, item, servings: Math.floor(batches) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function pairScore(index, a, b, recipes) {
  const entry = bestEdge(index, a.id, b.id, recipes);
  if (entry) {
    return { score: entry.edge.strength, basis: "recorded", evidence_type: entry.edge.evidence_type, relation: entry.edge.relation, explanation: entry.edge.explanation, provider: entry.edge.provider, confidence: entry.edge.confidence };
  }
  const similarity = aromaSimilarity(a, b);
  return { score: round(0.5 * similarity, 3), basis: "profile", evidence_type: null, relation: null, explanation: `No recorded pairing; aroma profiles overlap ${round(similarity * 100, 0)}% (calculated).`, provider: null, confidence: null };
}

function compatibility(index, ingredients, recipes) {
  const pairs = [];
  for (let i = 0; i < ingredients.length; i += 1) {
    for (let j = i + 1; j < ingredients.length; j += 1) {
      const a = ingredients[i];
      const b = ingredients[j];
      // Neutral carriers (soda water, still water) pair with anything.
      if (isNeutral(a) || isNeutral(b)) continue;
      pairs.push({ a: a.slug, b: b.slug, a_name: a.name, b_name: b.name, ...pairScore(index, a, b, recipes) });
    }
  }
  const score = pairs.length ? pairs.reduce((sum, pair) => sum + pair.score, 0) / pairs.length : 0.5;
  return { score: round(score, 3), pairs };
}

function isNeutral(ingredient) {
  return Object.keys(ingredient.aroma).length === 0 && TASTE_KEYS.every((key) => ingredient.taste[key] === 0);
}

function tasteTotals(lines, options) {
  const totals = { sweet: 0, sour: 0, bitter: 0, alcohol_ml: 0, volume: 0 };
  lines.forEach((line, position) => {
    const option = options[position];
    if (!option || !line.volume_ml) return;
    totals.sweet += line.volume_ml * option.taste.sweet;
    totals.sour += line.volume_ml * option.taste.sour;
    totals.bitter += line.volume_ml * option.taste.bitter;
    totals.alcohol_ml += line.volume_ml * (num(option.ingredient.abv_typical, 0) / 100);
    totals.volume += line.volume_ml;
  });
  return totals;
}

function balanceScore(template, totals) {
  const sweet = totals.sweet;
  const sour = totals.sour;
  switch (template.balance) {
    case "sour_ratio": {
      if (sour <= 0) return { score: 0, note: "no sour element" };
      const ratio = sweet / sour;
      const score = ratio >= 0.6 && ratio <= 1.2 ? 1 : clamp(1 - Math.abs(Math.log(ratio / 0.85)) / Math.log(3), 0, 1);
      return { score: round(score, 3), note: `sweet:sour ${round(ratio, 2)} (target 0.6–1.2)` };
    }
    case "bittersweet": {
      const share = sweet + totals.bitter > 0 ? sweet / (sweet + totals.bitter) : 0;
      return { score: round(clamp(1 - Math.abs(share - 0.65) * 2, 0, 1), 3), note: `sweet share ${round(share, 2)} of sweet+bitter (target 0.65)` };
    }
    case "coffee": {
      const share = sweet + totals.bitter > 0 ? sweet / (sweet + totals.bitter) : 0;
      return { score: round(clamp(1 - Math.abs(share - 0.5) * 2, 0, 1), 3), note: `sweet share ${round(share, 2)} against coffee bitterness (target 0.5)` };
    }
    case "light": {
      const density = totals.volume ? sweet / totals.volume : 0;
      const score = density >= 0.3 && density <= 1.6 ? 1 : clamp(1 - Math.abs(density - 0.9) / 1.5, 0, 1);
      return { score: round(score, 3), note: `sweetness density ${round(density, 2)} (target 0.3–1.6)` };
    }
    default:
      return { score: null, note: "not applicable" };
  }
}

function textureScore(template, options, lines, index, recipes) {
  let score = 0.7;
  const has = (predicate) => options.some((option, position) => option && lines[position] && predicate(option));
  if (template.texture === "carbonated") score = has((o) => SELECT.top(o) || SELECT.sparkling(o)) ? 1 : 0.5;
  else if (template.texture === "creamy") score = has((o) => SELECT.milk(o)) ? 1 : 0.6;
  else if (template.texture === "foamy") score = template.technique === "shaken" ? 0.9 : 0.6;
  else if (template.texture === "silky") score = has((o) => ["syrupy", "creamy"].includes(o.texture)) ? 1 : 0.85;
  else if (template.texture === "any") score = null;
  const recorded = [];
  const core = options.filter(Boolean).map((option) => option.ingredient);
  for (let i = 0; i < core.length; i += 1) {
    for (let j = i + 1; j < core.length; j += 1) {
      const entry = bestEdge(index, core[i].id, core[j].id, null);
      if (entry?.edge.texture_score !== null && entry?.edge.texture_score !== undefined) recorded.push(entry.edge.texture_score);
    }
  }
  if (score !== null && recorded.length) score = 0.5 * score + 0.5 * (recorded.reduce((sum, value) => sum + value, 0) / recorded.length);
  return score === null ? null : round(score, 3);
}

function jaccard(a, b) {
  const union = new Set([...a, ...b]);
  if (!union.size) return 0;
  let inter = 0;
  for (const value of a) if (b.has(value)) inter += 1;
  return inter / union.size;
}

function menuScores(index, ingredientIds, recipes) {
  let best = { similarity: 0, recipe: null };
  const set = new Set(ingredientIds);
  for (const recipe of arr(recipes)) {
    const ids = ingredientIdsOfRecipe(index, recipe);
    if (!ids.size) continue;
    const similarity = jaccard(set, ids);
    if (similarity > best.similarity || (similarity === best.similarity && best.recipe && str(recipe.name) < best.recipe.name)) {
      best = { similarity, recipe: { id: str(recipe.id), name: str(recipe.name), active: recipe.active !== false } };
    }
  }
  return { similarity: round(best.similarity, 3), novelty: round(1 - best.similarity, 3), closest_recipe: best.similarity > 0 ? best.recipe : null };
}

// Verified overstock: verified quantity at or above twice a positive par.
// The only "use soon" signal Atlas can back with verified data (Atlas does
// not record expiry, opening dates or shelf life).
export function isOverstocked(item) {
  const quantity = verifiedQuantity(item);
  const par = num(item?.par_level);
  return quantity !== null && par !== null && par > 0 && quantity >= 2 * par;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const TYPE_WORDS = {
  cocktail: ["cocktail", "highball", "sour", "spritz", "martini", "collins"],
  mocktail: ["mocktail", "zero", "non-alcoholic", "alcohol-free", "soft"],
  coffee: ["coffee", "espresso", "latte"],
};

// Reference menu price: the median price of active menu recipes of the same
// kind (managers only; the caller decides whether to compute economics).
export function priceReference(recipes, type) {
  const words = TYPE_WORDS[type] || [type];
  const comparable = arr(recipes).filter((recipe) => recipe && recipe.active !== false && num(recipe.menu_price) > 0
    && words.some((word) => str(recipe.type).toLowerCase().includes(word)));
  const price = median(comparable.map((recipe) => num(recipe.menu_price)));
  return { reference_price: price, comparable_count: comparable.length, basis: price === null ? `no priced active ${type} recipes to compare` : `median menu price of ${comparable.length} active ${type} recipe${comparable.length === 1 ? "" : "s"}` };
}

function economics(lines, itemsById, recipes, type) {
  const reference = priceReference(recipes, type);
  const toBuy = lines.filter((line) => line.to_buy).length;
  const items = lines.filter((line) => line.item_id).map((line) => itemsById.get(line.item_id)).filter(Boolean);
  const metrics = recipeMetrics(syntheticRecipe(lines, { menuPrice: reference.reference_price }), items);
  const financials = metrics.financials;
  const complete = !toBuy && financials.incomplete === 0 && Number.isFinite(financials.perServing);
  return {
    cost_per_serve: complete ? round(financials.perServing, 0) : null,
    margin_at_price: complete && Number.isFinite(financials.margin) ? round(financials.margin, 1) : null,
    price_support: reference,
    missing: complete ? null : toBuy ? `${toBuy} to-buy ingredient${toBuy === 1 ? " has" : "s have"} no Atlas cost` : `${financials.incomplete} ingredient cost${financials.incomplete === 1 ? " is" : "s are"} missing`,
    line_costs: metrics.rows.map((row) => ({ item_id: str(row.item?.id ?? row.ingredient?.item_id), cost: Number.isFinite(row.cost) ? round(row.cost, 0) : null })),
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export const MIN_COMPATIBILITY = 0.4;

const RANK_WEIGHTS = {
  balanced: { compatibility: 0.35, balance: 0.2, texture: 0.1, coverage: 0.2, novelty: 0.1, simplicity: 0.05 },
  use_stock: { coverage: 0.35, compatibility: 0.3, balance: 0.15, use_soon: 0.1, servings: 0.1 },
  low_cost: { cost: 0.45, compatibility: 0.3, balance: 0.25 },
  high_margin: { margin: 0.45, compatibility: 0.3, balance: 0.25 },
  novel: { novelty: 0.4, compatibility: 0.35, balance: 0.25 },
  simple: { simplicity: 0.4, compatibility: 0.35, balance: 0.25 },
};

function roleScore(option, role, seeds, index, recipes) {
  let score = option.status === "available" ? 1 : 0.4;
  if (seeds.has(option.ingredient.id)) score += 2;
  let best = 0;
  for (const seedId of seeds) {
    if (seedId === option.ingredient.id) continue;
    const entry = bestEdge(index, option.ingredient.id, seedId, recipes);
    if (entry) best = Math.max(best, entry.edge.strength);
  }
  score += best;
  if (role.select === "sour") score += option.taste.sour / 10 + (option.prep?.slug === "juice" ? 0.2 : 0);
  if (["sweet", "sweet_nonalc"].includes(role.select)) score += option.taste.sweet / 20;
  return score;
}

function* product(pools, position = 0, chosen = []) {
  if (position === pools.length) {
    yield chosen;
    return;
  }
  for (const option of pools[position]) yield* product(pools, position + 1, [...chosen, option]);
}

function shortName(ingredient) {
  const base = ingredient.name.replace(/\(.*?\)/g, " ")
    .replace(/\b(syrup|liqueur|juice|water|fresh|purée|puree|style|bitters|london dry|blanco|beans?|milk)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  return (base || ingredient.name).split(" ").slice(0, 2)
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word)).join(" ");
}

function plainSweetener(ingredient) {
  return Boolean(ingredient) && ingredient.family === "sweetener" && ["syrup", "sugar"].includes(ingredient.subfamily);
}

function nameFor(template, parts, featured) {
  const get = (role) => parts.find((part) => part.role === role)?.option.ingredient;
  const feature = featured ? shortName(featured) : null;
  switch (template.key) {
    case "sour": return `${plainSweetener(get("sweet")) ? "" : `${shortName(get("sweet"))} `}${shortName(get("base"))} Sour`;
    case "collins": return `${plainSweetener(get("sweet")) ? "" : `${shortName(get("sweet"))} `}${shortName(get("base"))} Collins`;
    case "highball": return `${shortName(get("base"))} & ${shortName(get("top"))}`;
    case "stirred": return `${shortName(get("base"))} & ${shortName(get("modifier"))}`;
    case "old_fashioned": return `${plainSweetener(get("sweet")) ? "" : `${shortName(get("sweet"))} `}${shortName(get("base"))} Old Fashioned`;
    case "spritz": return `${shortName(get("aperitif"))} Spritz`;
    case "coffee_cocktail": return `${plainSweetener(get("sweet")) || get("sweet")?.family === "liqueur" && get("sweet")?.subfamily === "coffee_liqueur" ? "" : `${shortName(get("sweet"))} `}${shortName(get("base"))} Espresso Martini`;
    case "cordial_soda": return `${shortName(get("flavour"))} ${get("top")?.subfamily === "carbonated" && /tonic/i.test(get("top").name) ? "Tonic" : "Soda"}`;
    case "zero_sour": return `${shortName(get("fruit"))} Zero Sour`;
    case "iced_latte": return `${shortName(get("flavour"))} Iced ${/oat/i.test(get("milk")?.name || "") ? "Oat " : ""}Latte`;
    default: return `${feature || shortName(parts[0].option.ingredient)} ${template.name}`;
  }
}

// Recipe names are at most 120 characters (the recipe.draft schema); a suffix
// shortens the base name instead of running past the limit.
const NAME_MAX = 120;
const withSuffix = (name, suffix) => `${name.slice(0, NAME_MAX - suffix.length).trimEnd()}${suffix}`;

function uniqueName(name, recipes) {
  const base = str(name).trim().slice(0, NAME_MAX).trimEnd();
  const taken = new Set(arr(recipes).map((recipe) => str(recipe?.name).trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 50; n += 1) {
    const next = withSuffix(base, ` No. ${n}`);
    if (!taken.has(next.toLowerCase())) return next;
  }
  return withSuffix(base, " (Atlas draft)");
}

function keyFor(template, parts) {
  return ["v1", template.key, ...parts.map((part) => `${part.role}=${part.option.ingredient.slug}~${part.option.prep?.slug ?? "-"}@${part.line?.item_id ?? (part.option.status === "to_buy" ? "buy" : "none")}`)].join("|");
}

function garnishFor(template, used, options, itemsById, index, recipes, exclude) {
  if (template.composable === false) return null;
  const families = template.garnishFamilies ?? ["herb", "citrus"];
  if (!families.length) return null;
  const usedIds = new Set(used.map((option) => option.ingredient.id));
  const role = { role: "garnish", select: "garnish", ml: 0, required: false };
  const ranked = options
    .filter((option) => option.status === "available" && SELECT.garnish(option) && families.includes(option.ingredient.family) && !isSweetPrep(option) && !excludedBy(option.ingredient, exclude))
    .map((option) => ({ option, score: Math.max(0, ...used.map((other) => bestEdge(index, option.ingredient.id, other.ingredient.id, recipes)?.edge.strength ?? 0)) + (usedIds.has(option.ingredient.id) ? 0.2 : 0) }))
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score || a.option.key.localeCompare(b.option.key));
  for (const { option } of ranked) {
    const picked = pickItem(role, option, itemsById, template.key);
    if (picked) return { role: "garnish", option, line: picked.line, servings: picked.servings };
  }
  return null;
}

function fill(template, text, parts, garnishText) {
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    if (key === "garnish") return garnishText;
    const part = parts.find((entry) => entry.role === key);
    if (!part?.line) return "";
    return part.roleDef.required ? part.line.display : ` and ${part.line.display}`;
  });
}

function assemble(index, template, parts, garnish, context) {
  const { itemsById, recipes, type, includeEconomics, overstock } = context;
  const lines = parts.map((part) => part.line).filter(Boolean);
  if (garnish) lines.push(garnish.line);
  const options = parts.map((part) => part.option);
  if (garnish) options.push(garnish.option);
  const core = parts.map((part) => part.option.ingredient);
  const compat = compatibility(index, core, recipes);
  const totals = tasteTotals(lines, options);
  const balance = balanceScore(template, totals);
  const texture = textureScore(template, parts.map((part) => part.option), parts.map((part) => part.line), index, recipes);
  const stocked = lines.filter((line) => line.item_id);
  const items = stocked.map((line) => itemsById.get(line.item_id)).filter(Boolean);
  const availability = template.composable === false ? null : recipeMetrics(syntheticRecipe(lines), items).availability;
  const servings = availability?.servings ?? null;
  const limiting = availability?.limiting?.item?.name ?? null;
  const coverage = lines.length ? stocked.length / lines.length : 0;
  const overstockLines = stocked.filter((line) => overstock.has(line.item_id)).length;
  const menu = menuScores(index, core.map((ingredient) => ingredient.id), recipes);
  const steps = template.method.length;
  const scores = {
    flavor: { compatibility: compat.score, balance: balance.score, texture },
    inventory: {
      coverage: round(coverage, 3),
      low_stock_risk: template.composable === false ? null : {
        level: servings === null ? "unknown" : servings < 6 ? "high" : servings < 20 ? "medium" : "low",
        servings_possible: servings,
        limiting_item: limiting,
      },
      use_soon: { supported: true, overstock_lines: overstockLines, basis: "verified stock at or above twice its par level; Atlas has no expiry or opened-date data" },
    },
    economics: null,
    operations: { steps, ingredient_count: lines.length, equipment: [...template.equipment], batching: template.batching },
    menu,
  };
  let costing = null;
  if (includeEconomics && template.composable !== false) {
    costing = economics(lines, itemsById, recipes, type);
    scores.economics = { cost_per_serve: costing.cost_per_serve, margin_at_price: costing.margin_at_price, price_support: costing.price_support, missing: costing.missing };
  }
  const garnishText = garnish ? garnish.line.display : "nothing (no suitable garnish in verified stock)";
  const featured = context.seedIds.size ? core.find((ingredient) => context.seedIds.has(ingredient.id)) : null;
  let baseName = template.composable === false ? `${core.map((ingredient) => shortName(ingredient)).join(", ")} ${template.name.toLowerCase()}` : nameFor(template, parts, featured);
  // An idea asked for with an ingredient carries that ingredient in its name.
  if (featured && !baseName.toLowerCase().includes(shortName(featured).toLowerCase())) baseName = `${shortName(featured)} ${baseName}`;
  const name = template.composable === false ? baseName : uniqueName(baseName, recipes);
  return {
    key: keyFor(template, [...parts, ...(garnish ? [{ role: "garnish", option: garnish.option, line: garnish.line }] : [])]),
    template: { key: template.key, name: template.name, technique: template.technique, glass: template.glass },
    type,
    name,
    composable: template.composable !== false,
    ingredients: [...parts, ...(garnish ? [garnish] : [])].map((part) => ({
      role: part.role,
      slug: part.option.ingredient.slug,
      name: part.option.ingredient.name,
      family: part.option.ingredient.family,
      preparation: part.option.prep?.slug ?? null,
      item: part.line?.item_id ? { id: part.line.item_id, name: part.line.item_name } : null,
      to_buy: part.option.status === "to_buy",
      stock_status: part.option.status === "to_buy" ? "to_buy" : "available",
    })),
    lines: template.composable === false ? [] : lines.map((line) => ({ role: line.role, item_id: line.item_id, item_name: line.item_name, quantity: line.quantity, unit: line.unit, display: line.display, to_buy: line.to_buy })),
    scores,
    pairs: compat.pairs,
    balance_note: balance.note,
    to_buy: lines.filter((line) => line.to_buy).map((line) => line.ingredient_name),
    _internal: { template, parts, garnish, lines, options, totals, costing },
  };
}

function rankOf(candidate, goal, context) {
  const { scores } = candidate;
  const weights = RANK_WEIGHTS[goal] || RANK_WEIGHTS.balanced;
  const values = {
    compatibility: scores.flavor.compatibility ?? 0,
    balance: scores.flavor.balance ?? 0.5,
    texture: scores.flavor.texture ?? 0.5,
    coverage: scores.inventory.coverage ?? 0,
    novelty: scores.menu.novelty ?? 0,
    simplicity: clamp(1 - (scores.operations.ingredient_count - 2) / 5, 0, 1),
    use_soon: scores.inventory.use_soon?.overstock_lines ? 1 : 0,
    servings: scores.inventory.low_stock_risk?.servings_possible ? clamp(scores.inventory.low_stock_risk.servings_possible / 30, 0, 1) : 0,
    cost: scores.economics?.cost_per_serve !== null && scores.economics?.cost_per_serve !== undefined && context.maxCost ? clamp(1 - scores.economics.cost_per_serve / context.maxCost, 0, 1) : 0,
    margin: scores.economics?.margin_at_price !== null && scores.economics?.margin_at_price !== undefined ? clamp(scores.economics.margin_at_price / 100, 0, 1) : 0,
  };
  let key = 0;
  for (const [dimension, weight] of Object.entries(weights)) key += weight * values[dimension];
  return { key: round(key, 4), goal, weights: { ...weights } };
}

// Ranked candidate structures from the templates. Every dimension is
// returned; `rank.key` is only an ordering key for the chosen goal.
export function candidates(index, {
  stock, items = [], recipes = [], type = null, seed = [], exclude = null, noNewPurchases = true, goal = "balanced", limit = 5, includeEconomics = false,
} = {}) {
  const types = type ? [type] : DRINK_TYPES;
  const effectiveGoal = !includeEconomics && ["low_cost", "high_margin"].includes(goal) ? "balanced" : (GOALS.includes(goal) ? goal : "balanced");
  const itemsById = new Map(arr(items).map((item) => [str(item.id), item]));
  const seedIds = new Set(arr(seed).map((entry) => (typeof entry === "object" ? entry.id : entry)).filter(Boolean));
  const options = buildOptions(index, stock, { noNewPurchases, exclude });
  const overstock = new Set(arr(items).filter(isOverstocked).map((item) => str(item.id)));
  const notes = [];
  const unmetSeeds = [];
  for (const seedId of seedIds) {
    const ingredient = index.byId.get(seedId);
    if (!ingredient) continue;
    if (excludedBy(ingredient, exclude)) {
      unmetSeeds.push({ slug: ingredient.slug, name: ingredient.name, reason: "excluded by your filters" });
      continue;
    }
    if (!options.some((option) => option.ingredient.id === seedId)) {
      const entry = stockFor(stock, seedId);
      unmetSeeds.push({ slug: ingredient.slug, name: ingredient.name, reason: entry.status === "out" ? "verified out of stock" : entry.status === "unknown" ? `stock unknown (${entry.reason})` : "not stocked in Atlas", stock_status: entry.status });
    }
  }
  const context = { itemsById, recipes, includeEconomics, overstock, seedIds, maxCost: 0 };
  const built = [];
  if (!unmetSeeds.length) {
    for (const drinkType of types) {
      for (const template of templatesFor(drinkType)) {
        const required = template.roles.filter((role) => role.required);
        const optional = template.roles.filter((role) => !role.required);
        const pools = required.map((role) => options
          .filter((option) => optionFits(template, role, option))
          .map((option) => ({ option, score: roleScore(option, role, seedIds, index, recipes) }))
          .sort((a, b) => b.score - a.score || a.option.key.localeCompare(b.option.key))
          // One option per ingredient per role (the best-scored preparation).
          .filter((entry, position, list) => list.findIndex((other) => other.option.ingredient.id === entry.option.ingredient.id) === position)
          .slice(0, 6)
          .map((entry) => entry.option));
        if (pools.some((pool) => !pool.length)) continue;
        for (const combo of product(pools)) {
          const ids = combo.map((option) => option.ingredient.id);
          if (new Set(ids).size !== ids.length) continue;
          if ([...seedIds].some((seedId) => !ids.includes(seedId))) continue;
          const parts = [];
          let ok = true;
          for (let position = 0; position < required.length; position += 1) {
            const role = required[position];
            const option = combo[position];
            if (template.composable === false) {
              parts.push({ role: role.role, roleDef: role, option, line: null });
              continue;
            }
            const picked = pickItem(role, option, itemsById, template.key);
            if (!picked) { ok = false; break; }
            parts.push({ role: role.role, roleDef: role, option, line: picked.line });
          }
          if (!ok) continue;
          if (SOUR_TEMPLATES.has(template.key)) tuneSweet(parts, itemsById);
          for (const role of optional) {
            const usedIds = new Set(parts.map((part) => part.option.ingredient.id));
            const best = options
              .filter((option) => option.status === "available" && !usedIds.has(option.ingredient.id) && optionFits(template, role, option))
              .map((option) => ({ option, compat: compatibility(index, [...parts.map((part) => part.option.ingredient), option.ingredient], recipes).score }))
              .filter((entry) => entry.compat >= 0.55)
              .sort((a, b) => b.compat - a.compat
                || Number(b.option.prep?.slug === "juice") - Number(a.option.prep?.slug === "juice")
                || a.option.key.localeCompare(b.option.key))[0];
            if (!best) continue;
            if (template.composable === false) {
              parts.push({ role: role.role, roleDef: role, option: best.option, line: null });
              continue;
            }
            const picked = pickItem(role, best.option, itemsById, template.key);
            if (picked) parts.push({ role: role.role, roleDef: role, option: best.option, line: picked.line });
          }
          const garnish = garnishFor(template, parts.map((part) => part.option), options, itemsById, index, recipes, exclude);
          const assembled = assemble(index, template, parts, garnish, { ...context, type: drinkType });
          // Weak combinations (mostly unrecorded pairs) are not offered.
          if ((assembled.scores.flavor.compatibility ?? 0) < MIN_COMPATIBILITY) continue;
          built.push(assembled);
        }
      }
    }
  }
  context.maxCost = Math.max(0, ...built.map((candidate) => candidate.scores.economics?.cost_per_serve ?? 0));
  for (const candidate of built) candidate.rank = rankOf(candidate, effectiveGoal, context);
  built.sort((a, b) => b.rank.key - a.rank.key || a.key.localeCompare(b.key));
  // Diversity: at most two per template and no near-duplicate ingredient sets.
  const picked = [];
  const perTemplate = new Map();
  for (const candidate of built) {
    if (picked.length >= limit) break;
    const count = perTemplate.get(candidate.template.key) || 0;
    if (count >= 2) continue;
    if (picked.some((other) => other.name === candidate.name)) continue;
    const slugs = new Set(candidate.ingredients.filter((part) => part.role !== "garnish").map((part) => part.slug));
    if (picked.some((other) => jaccard(slugs, new Set(other.ingredients.filter((part) => part.role !== "garnish").map((part) => part.slug))) >= 0.75)) continue;
    perTemplate.set(candidate.template.key, count + 1);
    picked.push(candidate);
  }
  if (goal !== effectiveGoal) notes.push(`Ranking by ${goal.replace("_", " ")} needs cost data, which is for managers; ranked by overall balance instead.`);
  // Requested ingredients that are in verified stock but fit no idea, with the honest reason.
  const unusedSeeds = [];
  if (!unmetSeeds.length) {
    for (const seedId of seedIds) {
      if (built.some((candidate) => candidate.ingredients.some((part) => part.slug === index.byId.get(seedId)?.slug))) continue;
      const ingredient = index.byId.get(seedId);
      if (!ingredient) continue;
      const seedOptions = options.filter((option) => option.ingredient.id === seedId && option.status === "available");
      const measurable = seedOptions.some((option) => option.items.some((stockItem) => {
        const item = itemsById.get(stockItem.item_id);
        return item && ["ml", "g"].includes(itemBase(item));
      }));
      const produceOnly = seedOptions.length > 0 && seedOptions.every((option) => PRODUCE_FAMILIES.has(option.ingredient.family) && !option.prep);
      unusedSeeds.push({
        slug: ingredient.slug,
        name: ingredient.name,
        reason: produceOnly
          ? "in verified stock only as whole produce; a drink needs it juiced or made into a syrup or cordial first, and Atlas does not assume one exists"
          : !measurable
            ? "in verified stock, but its package size is not set, so a serve cannot be measured (set the size in Inventory)"
            : "no drink template pairs it with enough verified stock",
      });
    }
  }
  if (!built.length && !unmetSeeds.length && !unusedSeeds.length) notes.push(noNewPurchases ? "No template can be completed from verified stock with these filters." : "No template can be completed with these filters.");
  return {
    candidates: picked.map(({ _internal, ...candidate }) => ({ ...candidate })),
    considered: built.length,
    goal: effectiveGoal,
    unmet_seeds: unmetSeeds,
    unused_seeds: unusedSeeds,
    unmeasurable: unmeasurableItems(options, itemsById),
    notes,
    _full: picked,
  };
}

// Verified, available items the engine cannot measure a serve from (no
// package size in ml/g and not whole fruit): reported so the data can be fixed.
function unmeasurableItems(options, itemsById) {
  const seen = new Map();
  for (const option of options) {
    if (option.status !== "available") continue;
    for (const stockItem of option.items) {
      const item = itemsById.get(stockItem.item_id);
      if (!item || seen.has(stockItem.item_id)) continue;
      const base = itemBase(item);
      const countable = base === "each" && PRODUCE_FAMILIES.has(option.ingredient.family) && !PROCESSED_NAME.test(str(item.name));
      if (["ml", "g"].includes(base) || countable || base === "bunch") continue;
      seen.set(stockItem.item_id, { item_id: stockItem.item_id, name: stockItem.name, unit: item.unit ?? null, ingredient: option.ingredient.slug });
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Sour-family ratio: sweet quantity tuned so sweet:sour is about 0.85,
// rounded to 2.5 ml within 10–30 ml (ml/g lines only). The tuned quantity
// must still be covered by verified stock for one serve, otherwise the
// template amount stays.
function tuneSweet(parts, itemsById) {
  const sour = parts.find((part) => part.role === "sour");
  const sweet = parts.find((part) => part.role === "sweet");
  if (!sour?.line || !sweet?.line || !["ml", "g"].includes(sweet.line.unit) || !sweet.option.taste.sweet) return;
  const sourUnits = sour.line.volume_ml * sour.option.taste.sour;
  // Liqueurs also add alcohol and body, so they stop at 25 ml.
  const ceiling = sweet.option.ingredient.family === "liqueur" ? 25 : 30;
  const target = clamp(roundTo((0.85 * sourUnits) / sweet.option.taste.sweet, 2.5), 10, ceiling);
  if (target === sweet.line.quantity) return;
  const next = { ...sweet.line, quantity: target, volume_ml: target };
  next.display = labelOf(next);
  if (next.item_id) {
    const item = itemsById.get(next.item_id);
    const batches = item ? recipeMetrics(syntheticRecipe([next]), [item]).rows[0]?.batches : null;
    if (!Number.isFinite(batches) || batches < 1) return;
  }
  sweet.line = next;
}

// ---------------------------------------------------------------------------
// Candidate keys and composition
// ---------------------------------------------------------------------------

export function parseCandidateKey(key) {
  const parts = str(key).split("|");
  if (parts[0] !== "v1" || parts.length < 3) throw new FlavorError("invalid_arguments", "That idea reference is not valid. Ask for fresh ideas.");
  const template = TEMPLATE_BY_KEY.get(parts[1]);
  if (!template) throw new FlavorError("invalid_arguments", "That idea reference is not valid. Ask for fresh ideas.");
  const roles = parts.slice(2).map((part) => {
    const match = part.match(/^([a-z_]+)=([a-z0-9-]+)~([a-z0-9-]+)@([0-9a-fA-F-]{36}|buy|none)$/);
    if (!match) throw new FlavorError("invalid_arguments", "That idea reference is not valid. Ask for fresh ideas.");
    return { role: match[1], slug: match[2], prep: match[3] === "-" ? null : match[3], item: match[4] };
  });
  return { template, roles };
}

// Rebuilds a candidate from its key against CURRENT data: every ingredient
// must exist, every item must be a confirmed link of that ingredient with
// verified stock now, and every role must still accept it. Nothing from the
// key is trusted as stock.
export function candidateFromKey(index, key, { stock, items = [], recipes = [], noNewPurchases = true, includeEconomics = false, type = null } = {}) {
  const { template, roles } = parseCandidateKey(key);
  if (template.composable === false) throw new FlavorError("not_supported", "Atlas drafts drink specs only; dessert and food ideas stay pairing notes.");
  const itemsById = new Map(arr(items).map((item) => [str(item.id), item]));
  const parts = [];
  let garnish = null;
  // A key must have the shape the engine builds: each template role at most
  // once, at most one garnish, nothing outside the template.
  const seenRoles = new Set();
  for (const entry of roles) {
    if (seenRoles.has(entry.role)) throw new FlavorError("invalid_arguments", "That idea reference repeats a role. Ask for fresh ideas.");
    seenRoles.add(entry.role);
  }
  for (const entry of roles) {
    const ingredient = index.bySlug.get(entry.slug);
    if (!ingredient) throw new FlavorError("conflict", "An ingredient in that idea is no longer in the flavour library. Ask for fresh ideas.");
    const prep = entry.prep ? index.prepBySlug.get(entry.prep) || null : null;
    if (entry.prep && !prep) throw new FlavorError("conflict", "A preparation in that idea is no longer in the flavour library. Ask for fresh ideas.");
    const roleDef = entry.role === "garnish" ? { role: "garnish", select: "garnish", ml: 0, required: false } : template.roles.find((role) => role.role === entry.role);
    if (!roleDef) throw new FlavorError("invalid_arguments", "That idea reference is not valid. Ask for fresh ideas.");
    let option;
    if (entry.item === "buy") {
      if (noNewPurchases) throw new FlavorError("conflict", `${ingredient.name} is not in verified stock and new purchases are not allowed.`);
      option = makeOption(ingredient, null, [], "to_buy");
    } else {
      const stockEntry = stockFor(stock, ingredient.id);
      const stockItem = stockEntry.items.find((candidate) => candidate.item_id === entry.item && candidate.available && (candidate.preparation?.id ?? null) === (prep?.id ?? null));
      if (!stockItem) throw new FlavorError("conflict", `${ingredient.name} is no longer available from verified stock. Ask for fresh ideas.`);
      option = makeOption(ingredient, prep, [stockItem], "available");
    }
    const garnishFamilies = template.garnishFamilies ?? ["herb", "citrus"];
    const fits = entry.role === "garnish"
      ? SELECT.garnish(option) && garnishFamilies.includes(ingredient.family) && !isSweetPrep(option)
      : optionFits(template, roleDef, option);
    if (!fits) throw new FlavorError("invalid_arguments", "That idea reference does not match its template. Ask for fresh ideas.");
    const picked = pickItem(roleDef, option, itemsById, template.key);
    if (!picked) throw new FlavorError("conflict", `Verified stock of ${ingredient.name} does not cover one serve. Ask for fresh ideas.`);
    if (entry.role === "garnish") garnish = { role: "garnish", roleDef, option, line: picked.line };
    else parts.push({ role: entry.role, roleDef, option, line: picked.line });
  }
  for (const role of template.roles.filter((candidate) => candidate.required)) {
    if (!parts.some((part) => part.role === role.role)) throw new FlavorError("invalid_arguments", "That idea reference is incomplete. Ask for fresh ideas.");
  }
  const ids = parts.map((part) => part.option.ingredient.id);
  if (new Set(ids).size !== ids.length) throw new FlavorError("invalid_arguments", "That idea reference repeats an ingredient.");
  // Optional roles pass the same bar as in candidates(): each must pair well
  // (≥ 0.55) with the required roles and the optional ones before it.
  const accepted = parts.filter((part) => part.roleDef.required);
  for (const role of template.roles.filter((candidate) => !candidate.required)) {
    const part = parts.find((entry) => entry.role === role.role);
    if (!part) continue;
    const compat = compatibility(index, [...accepted.map((entry) => entry.option.ingredient), part.option.ingredient], recipes).score;
    if (!(compat >= 0.55)) throw new FlavorError("invalid_arguments", `${part.option.ingredient.name} does not pair well enough with the rest of that idea. Ask for fresh ideas.`);
    accepted.push(part);
  }
  if (SOUR_TEMPLATES.has(template.key)) tuneSweet(parts, itemsById);
  const drinkType = type && template.types.includes(type) ? type : template.types[0];
  const overstock = new Set(arr(items).filter(isOverstocked).map((item) => str(item.id)));
  const candidate = assemble(index, template, parts, garnish, { itemsById, recipes, includeEconomics, overstock, seedIds: new Set(), type: drinkType });
  if ((candidate.scores.flavor.compatibility ?? 0) < MIN_COMPATIBILITY) throw new FlavorError("invalid_arguments", "Those ingredients do not pair well enough to draft. Ask for fresh ideas.");
  candidate.rank = rankOf(candidate, "balanced", { maxCost: 0 });
  return candidate;
}

// Deterministic draft spec from a candidate (object from candidates()._full
// or candidateFromKey). Lines come only from verified items (or clearly
// marked to_buy lines when purchases are allowed); quantities never exceed
// verified stock for one serve (canonical recipeMetrics batches ≥ 1).
export function compose(index, candidate, { items = [], recipes = [], name = null, includeEconomics = false } = {}) {
  const internal = candidate?._internal;
  if (!internal) throw new FlavorError("invalid_arguments", "Compose needs a candidate built by the flavour engine.");
  const { template, parts, garnish, lines, options, totals } = internal;
  if (template.composable === false) throw new FlavorError("not_supported", "Atlas drafts drink specs only; dessert and food ideas stay pairing notes.");
  const itemsById = new Map(arr(items).map((item) => [str(item.id), item]));
  // No invented items: every item id must be a real, verified, available item.
  for (const line of lines) {
    if (line.to_buy) continue;
    const item = itemsById.get(line.item_id);
    if (!item || !isVerifiedAvailable(item)) throw new FlavorError("conflict", `${line.item_name} is not available from verified stock.`);
  }
  // One recipe line per item (recipe_ingredients is unique per recipe and
  // item): a garnish cut from the same fruit as a juice line is merged into it.
  const saved = mergeLines(lines);
  const stocked = saved.filter((line) => line.item_id);
  const metrics = recipeMetrics(syntheticRecipe(saved), stocked.map((line) => itemsById.get(line.item_id)));
  const perLine = metrics.rows.map((row) => ({ item_id: str(row.item?.id), batches: row.batches }));
  const short = perLine.filter((row) => !Number.isFinite(row.batches) || row.batches < 1);
  if (short.length) throw new FlavorError("conflict", "Verified stock does not cover one serve of this idea. Ask for fresh ideas.");
  const draftName = uniqueName(str(name) || candidate.name, recipes);
  const dilution = template.dilution;
  const liquid = totals.volume;
  const abv = liquid > 0 ? (totals.alcohol_ml / (liquid * (1 + dilution))) * 100 : 0;
  const garnishText = garnish ? garnish.line.display : "no garnish";
  const method = template.method.map((step) => fill(template, step, parts, garnishText))
    .map((step) => step.replace(/\s+/g, " ").replace(/ ,/g, ",").trim())
    .filter((step) => !/^Garnish with (no garnish|nothing)/.test(step));
  const allergens = [...new Set(options.flatMap((option) => option.ingredient.allergens))].sort();
  const toBuy = lines.filter((line) => line.to_buy);
  const servings = metrics.availability.servings;
  const checks = [
    { key: "no_invented_items", ok: true, detail: "Every line is a verified Atlas inventory item or a clearly marked to-buy ingredient." },
    { key: "verified_stock", ok: toBuy.length === 0, detail: toBuy.length ? `${toBuy.length} ingredient${toBuy.length === 1 ? " is" : "s are"} not in verified stock (to buy): ${toBuy.map((line) => line.ingredient_name).join(", ")}.` : "All ingredients come from verified current stock." },
    { key: "serve_within_stock", ok: true, detail: servings === null ? "Each stocked line covers at least one serve." : `Verified stock covers ${servings} serve${servings === 1 ? "" : "s"}${metrics.availability.limiting?.item?.name ? ` (limited by ${metrics.availability.limiting.item.name})` : ""}.` },
    { key: "balance", ok: (balanceScore(template, totals).score ?? 1) >= 0.6, detail: balanceScore(template, totals).note },
    ...(template.alcoholFree ? [{ key: "alcohol_free", ok: abv === 0 && options.every((option) => !option.alcoholic), detail: abv === 0 ? "No alcoholic ingredient." : "Contains alcohol." }] : []),
    { key: "allergens", ok: true, detail: allergens.length ? `Contains or may contain: ${allergens.join(", ")}.` : "No allergens recorded for these ingredients (check product labels)." },
    { key: "name_unique", ok: true, detail: draftName === (str(name) || candidate.name).trim().slice(0, NAME_MAX).trimEnd() ? "The name is not used by an existing recipe." : `Renamed to "${draftName}" because the name is already used.` },
  ];
  const draft = {
    name: draftName,
    type: DRAFT_TYPE[candidate.type] || DRAFT_TYPE.cocktail,
    template: template.key,
    glass: template.glass,
    technique: template.technique,
    method,
    garnish: garnish ? garnish.line.display : null,
    yield: { quantity: 1, unit: "serving" },
    lines: saved.map((line) => ({ item_id: line.item_id, item_name: line.item_name, quantity: line.quantity, unit: line.unit, role: line.role, display: line.display, to_buy: line.to_buy, ingredient_slug: line.ingredient_slug })),
    balance: {
      sweet: round(liquid ? totals.sweet / liquid : 0, 2),
      sour: round(liquid ? totals.sour / liquid : 0, 2),
      bitter: round(liquid ? totals.bitter / liquid : 0, 2),
      dilution_pct: round(dilution * 100, 0),
      abv_est: round(abv, 1),
      volume_ml: round(liquid, 0),
      final_volume_ml: round(liquid * (1 + dilution), 0),
    },
    servings_possible: servings,
    allergens,
    checks,
    candidate_key: candidate.key,
  };
  if (includeEconomics) {
    const costing = economics(saved, itemsById, recipes, candidate.type);
    draft.costing = { cost_per_serve: costing.cost_per_serve, margin_at_price: costing.margin_at_price, price_support: costing.price_support, missing: costing.missing, line_costs: costing.line_costs };
  }
  return draft;
}

function mergeLines(lines) {
  const merged = [];
  for (const line of lines) {
    const same = line.item_id ? merged.find((other) => other.item_id === line.item_id) : null;
    if (same && same.unit === line.unit) {
      same.quantity = round(same.quantity + line.quantity, 3);
      same.role = `${same.role}, ${line.role}`;
      same.display = `${same.display} + ${line.display}`;
      continue;
    }
    if (same) continue; // a garnish in another unit stays in the method text only
    merged.push({ ...line });
  }
  return merged;
}

// "Use soon": only verified overstock is backed by data. Returns the
// ingredients whose confirmed items are verified at ≥ 2 × par.
export function useSoon(index, stock, items) {
  const itemsById = new Map(arr(items).map((item) => [str(item.id), item]));
  const rows = [];
  for (const entry of stock.values()) {
    for (const stockItem of entry.items) {
      const item = itemsById.get(stockItem.item_id);
      if (!stockItem.available || !isOverstocked(item)) continue;
      rows.push({ ingredient: ingredientView(index.byId.get(entry.ingredient_id)), item_id: stockItem.item_id, item_name: stockItem.name, verified_quantity: stockItem.verified_quantity, unit: stockItem.unit, par_level: stockItem.par_level, ratio_to_par: round(stockItem.verified_quantity / stockItem.par_level, 2) });
    }
  }
  return rows.sort((a, b) => b.ratio_to_par - a.ratio_to_par || a.item_name.localeCompare(b.item_name));
}

export { DRAFT_TYPE, TEMPLATE_BY_KEY, TYPE_LABEL };
