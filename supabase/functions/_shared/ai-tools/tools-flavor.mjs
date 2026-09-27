// Flavor Intelligence tools (specialist: recipes).
//
// Every tool reads the flavour library (services.flavorSnapshot, the
// read-only atlas_flavor_snapshot RPC) and the canonical projected stock
// (services.projectedItems / stockReport — the same verified-current rule as
// inventory.current_stock). Pairing notes are culinary or Atlas-recipe
// evidence, reported as interpretation; stock is a fact only from a current
// verified count; cost and margin are calculations for managers only.
// recipes.compose_draft is the only draft tool: it prepares a recipe.draft
// proposal; nothing is saved until a manager approves the card.

import { MANAGER_ROLES } from "../auth.mjs";
import { S } from "./schema.mjs";
import { buildProposal } from "./actions.mjs";
import { calculation, fact, formatIsk, formatNumber, interpretation, missing, ok, record, source, ToolError } from "./result.mjs";
import { clampLimit, isManagerActor, newId } from "./helpers.mjs";
import { ServiceError } from "./services.mjs";
import {
  CANDIDATE_TYPES, DRINK_TYPES, EVIDENCE_TYPES, FLAVOR_ENGINE_VERSION, FlavorError, GOALS, RELATIONS, USES,
  aromaSimilarity, bestEdge, candidateFromKey, candidates as buildCandidates, compose, edgesOf, indexSnapshot,
  ingredientView, isOverstocked, pairings as buildPairings, preparationView, resolveIngredient,
  searchIngredients, stockByIngredient, stockFor, substitutes as buildSubstitutes, tasteSimilarity, useSoon,
} from "./flavor-graph.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const MANAGERS = [...MANAGER_ROLES];

const EVIDENCE_LABEL = {
  culinary: "culinary",
  atlas_learned: "Atlas recipes",
  scientific: "scientific",
  ai_interpretation: "AI interpretation",
};
const FRESHNESS_TEXT = {
  current: "verified by a current count",
  stale: "the last verified count has expired",
  historical: "only an old imported quantity exists",
  unverified: "never verified by a count",
  unknown: "no current verified count",
  inactive: "item is deactivated",
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const INDEX_CACHE = new WeakMap();

function indexFor(snapshot) {
  if (!INDEX_CACHE.has(snapshot)) INDEX_CACHE.set(snapshot, indexSnapshot(snapshot));
  return INDEX_CACHE.get(snapshot);
}

async function loadFlavor(ctx, { withRecipes = true } = {}) {
  let snapshot;
  try {
    snapshot = await ctx.services.flavorSnapshot();
  } catch (error) {
    if (error instanceof ServiceError && error.status === 403) throw error;
    throw new ToolError("unavailable", "The flavour library is not available right now. Atlas did not guess pairings.");
  }
  const [items, report, recipes] = await Promise.all([
    ctx.services.projectedItems(),
    ctx.services.stockReport(),
    withRecipes ? ctx.services.recipes() : Promise.resolve([]),
  ]);
  const index = indexFor(snapshot);
  const stock = stockByIngredient(index, items, { reportRows: report?.evidence_rows ?? report?.rows ?? [] });
  return { snapshot, index, items, stock, recipes: Array.isArray(recipes) ? recipes : [] };
}

function flavorFailure(error) {
  if (error instanceof FlavorError) {
    const code = { not_found: "not_found", conflict: "conflict", invalid_arguments: "invalid_arguments", not_supported: "invalid_arguments" }[error.code] ?? "unavailable";
    return new ToolError(code, error.message);
  }
  return error;
}

// Returns { ingredient } or { clarification: ToolResult }; throws not_found.
function resolveOne(index, ref, label = "ingredient") {
  const resolved = resolveIngredient(index, ref);
  if (resolved.status === "unique") return { ingredient: resolved.ingredient };
  if (resolved.status === "none") throw new ToolError("not_found", `"${ref}" is not in the flavour library.`);
  const names = resolved.candidates.map((candidate) => candidate.name);
  return {
    clarification: ok({
      summary: `"${ref}" matches ${names.length} ${label}s: ${names.join(", ")}. Ask which one.`,
      data: { needs_clarification: [{ query: ref, status: "ambiguous", candidates: resolved.candidates.map((candidate) => ({ slug: candidate.slug, name: candidate.name })) }] },
      evidence: [interpretation("Ambiguous ingredient name", names.join(" / "), null)],
    }),
  };
}

// ---------------------------------------------------------------------------
// Views and evidence
// ---------------------------------------------------------------------------

function stockView(entry) {
  return {
    status: entry.status,
    reason: entry.reason,
    items: entry.items.map((item) => ({
      item_id: item.item_id,
      name: item.name,
      unit: item.unit,
      verified_quantity: item.verified_quantity,
      freshness: item.freshness,
      available: item.available,
      preparation: item.preparation?.slug ?? null,
    })),
    possible_matches: entry.possible_matches.map((item) => ({
      item_id: item.item_id,
      name: item.name,
      link_status: "needs_review",
      counted_as_stock: false,
    })),
  };
}

function itemSource(item) {
  return source("inventory_item", item.item_id, item.name);
}

function stockEvidence(ingredient, entry) {
  const evidence = [];
  if (entry.status === "not_stocked") {
    evidence.push(missing(`${ingredient.name} in Atlas`, "not linked to any Atlas inventory item", null));
    return evidence;
  }
  for (const item of entry.items) {
    if (item.verified_quantity !== null) {
      evidence.push(fact(`Current stock of ${item.name}`, `${formatNumber(item.verified_quantity)} ${item.unit || "units"} (verified count)`, itemSource(item)));
    } else {
      evidence.push(missing(`Current stock of ${item.name}`, `unknown — ${FRESHNESS_TEXT[item.freshness] || "no current verified count"}`, itemSource(item)));
    }
  }
  for (const item of entry.possible_matches) {
    evidence.push(interpretation(`Possible match for ${ingredient.name}`, `${item.name} — the link needs review, so it is not counted as stock`, itemSource(item)));
  }
  return evidence;
}

function pairingEvidence(a, b, entry) {
  const label = EVIDENCE_LABEL[entry.evidence_type] || entry.evidence_type;
  const strength = entry.strength ?? entry.dims?.strength;
  return interpretation(`Pairing (${label}): ${a} + ${b}`, `${entry.explanation || entry.relation} (${entry.relation}, strength ${formatNumber(strength)})`, null);
}

function stockRecords(entries) {
  const records = [];
  for (const entry of entries) {
    for (const item of entry?.items || []) records.push(record("inventory_item", item.item_id, item.name));
  }
  return records;
}

function statusWord(status) {
  return { available: "in stock", out: "verified out of stock", unknown: "stock unknown", not_stocked: "not stocked" }[status] || status;
}

function unknownStock(entries) {
  const unknown = entries.filter((entry) => entry && entry.status === "unknown");
  return unknown.length ? { count: unknown.length, reason: "No current verified count (or only a possible match that needs review), so stock is unknown, not zero" } : null;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const searchIngredientsTool = {
  name: "flavor.search_ingredients",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Looking up ingredients",
  description: "Find canonical flavour-library ingredients by name, alias (English or Icelandic) or misspelling, with each one's verified stock status (in stock / verified out / unknown / not stocked). Use it to turn a word like 'rabarbari' or 'passionfruit' into an ingredient before asking for pairings or ideas.",
  parameters: S.object({
    query: S.string("Ingredient words, e.g. 'rhubarb' or 'passion fruit'", { maxLength: 100 }),
    use: S.nullable(S.enum(USES, "Only ingredients used in this kind of drink or dish")),
    limit: S.nullable(S.integer("Maximum results (default 10)", { minimum: 1, maximum: 25 })),
  }),
  async execute(args, ctx) {
    const { index, stock } = await loadFlavor(ctx, { withRecipes: false });
    const results = searchIngredients(index, args.query, { limit: clampLimit(args.limit, 10, 25), uses: args.use ? [args.use] : null });
    const rows = results.map((result) => {
      const entry = stockFor(stock, result.ingredient.id);
      return { ...ingredientView(result.ingredient), match: result.match, matched_text: result.via, score: result.score, stock_status: entry.status, in_stock: entry.status === "available" };
    });
    const entries = results.map((result) => stockFor(stock, result.ingredient.id));
    return ok({
      summary: rows.length
        ? `${rows.length} ${rows.length === 1 ? "ingredient matches" : "ingredients match"} "${args.query}": ${rows.map((row) => `${row.name} (${statusWord(row.stock_status)})`).join(", ")}.`
        : `No flavour-library ingredient matches "${args.query}".`,
      data: { results: rows, total: rows.length },
      evidence: results.flatMap((result, position) => stockEvidence(result.ingredient, entries[position])).slice(0, 20),
      records: stockRecords(entries),
      unknown: unknownStock(entries),
    });
  },
};

const ingredientProfile = {
  name: "flavor.ingredient_profile",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Reading the flavour profile",
  description: "One ingredient's flavour profile (aroma families, taste 0–5, intensity, texture, typical ABV, allergens, uses, preparations), its verified stock status with the linked Atlas items (possible matches that need review are listed but never counted), existing Atlas recipes that use it, and its strongest pairings.",
  parameters: S.object({
    ingredient: S.string("Ingredient name, alias or slug", { maxLength: 100 }),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock, recipes } = await loadFlavor(ctx);
      const resolved = resolveOne(index, args.ingredient);
      if (resolved.clarification) return resolved.clarification;
      const ingredient = resolved.ingredient;
      const entry = stockFor(stock, ingredient.id);
      const itemIds = new Set(index.links.filter((link) => link.ingredient_id === ingredient.id && link.status === "confirmed").map((link) => link.inventory_item_id));
      const using = recipes.filter((recipe) => recipe.active !== false && (recipe.recipe_ingredients || []).some((line) => itemIds.has(String(line.item_id))))
        .map((recipe) => ({ id: recipe.id, name: recipe.name }));
      const top = buildPairings(index, ingredient, { stock, recipes, limit: 5 }).neighbours;
      const aroma = Object.entries(ingredient.aroma).sort((a, b) => b[1] - a[1]);
      return ok({
        summary: `${ingredient.name} (${ingredient.family}${ingredient.subfamily ? `, ${ingredient.subfamily}` : ""}): ${statusWord(entry.status)}${entry.possible_matches.length ? `; ${entry.possible_matches.length} possible match${entry.possible_matches.length === 1 ? "" : "es"} need review` : ""}. Leading aromas: ${aroma.slice(0, 3).map(([key]) => key.replace(/_/g, " ")).join(", ") || "neutral"}.${using.length ? ` Used in ${using.map((recipe) => recipe.name).join(", ")}.` : ""}`,
        data: {
          ingredient: {
            ...ingredientView(ingredient),
            aroma: ingredient.aroma,
            taste: ingredient.taste,
            texture: ingredient.texture,
            abv_typical: ingredient.abv_typical,
            allergens: ingredient.allergens,
            dietary: ingredient.dietary,
            techniques: ingredient.techniques,
            preparations: (index.prepsByIngredient.get(ingredient.id) || []).map(preparationView),
            provider: ingredient.provider,
            confidence: ingredient.confidence,
          },
          stock: stockView(entry),
          recipes_using: using,
          top_pairings: top.map((neighbour) => ({ slug: neighbour.ingredient.slug, name: neighbour.ingredient.name, relation: neighbour.relation, strength: neighbour.dims.strength, evidence_type: neighbour.evidence_type, in_stock: neighbour.in_stock })),
          basis: "Flavour profiles are Atlas-curated culinary estimates (not laboratory data).",
        },
        evidence: [
          interpretation(`Flavour profile of ${ingredient.name}`, `${aroma.slice(0, 4).map(([key, value]) => `${key.replace(/_/g, " ")} ${formatNumber(value)}`).join(", ") || "neutral"} (Atlas-curated culinary profile)`, null),
          ...stockEvidence(ingredient, entry),
          ...(using.length ? [fact(`Atlas recipes using ${ingredient.name}`, using.map((recipe) => recipe.name).join(", "), null)] : []),
          ...top.slice(0, 5).map((neighbour) => pairingEvidence(ingredient.name, neighbour.ingredient.name, neighbour)),
        ],
        records: [...stockRecords([entry]), ...using.map((recipe) => record("recipe", recipe.id, recipe.name))],
        unknown: unknownStock([entry]),
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

function defaultCenter(index, stock) {
  let best = null;
  for (const ingredient of index.ingredients) {
    if (stockFor(stock, ingredient.id).status !== "available") continue;
    const degree = (index.adjacency.get(ingredient.id) || []).length;
    if (!best || degree > best.degree) best = { ingredient, degree };
  }
  return best?.ingredient ?? index.ingredients[0] ?? null;
}

const pairingsTool = {
  name: "flavor.pairings",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Finding pairings",
  description: "What pairs with an ingredient: neighbours with every dimension (strength, aroma, taste, texture), relation (complement, contrast, bridge), evidence type (culinary = Atlas-curated bar knowledge, atlas_learned = used together in existing Atlas recipes), confidence, explanation and verified stock status. Filters: preparation, use (cocktail, mocktail, coffee, dessert, food), in_stock_only, evidence types. Pairing notes are culinary evidence, not science. With ingredient null, starts from the best-connected ingredient in verified stock.",
  parameters: S.object({
    ingredient: S.nullable(S.string("Ingredient name, alias or slug", { maxLength: 100 })),
    preparation: S.nullable(S.string("Preparation slug, e.g. 'syrup' or 'juice'", { maxLength: 60 })),
    use: S.nullable(S.enum(USES, "Only partners used in this kind of drink or dish")),
    in_stock_only: S.nullable(S.boolean("Only partners with verified current stock")),
    evidence: S.nullable(S.array(S.enum(EVIDENCE_TYPES), "Evidence types to include", { minItems: 1, maxItems: 4 })),
    limit: S.nullable(S.integer("Maximum partners (default 24)", { minimum: 1, maximum: 40 })),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock, recipes, items } = await loadFlavor(ctx);
      let center;
      if (args.ingredient) {
        const resolved = resolveOne(index, args.ingredient);
        if (resolved.clarification) return resolved.clarification;
        center = resolved.ingredient;
      } else {
        center = defaultCenter(index, stock);
        if (!center) throw new ToolError("not_found", "The flavour library has no ingredients yet.");
      }
      const result = buildPairings(index, center, {
        prep: args.preparation,
        filters: { use: args.use, in_stock_only: args.in_stock_only === true, evidence: args.evidence },
        limit: clampLimit(args.limit, 24, 40),
        stock,
        recipes,
      });
      const all = buildPairings(index, center, { stock, recipes, limit: 500 }).neighbours;
      const centerEntry = stockFor(stock, center.id);
      const stockMap = { [center.slug]: stockView(centerEntry) };
      for (const neighbour of result.neighbours) stockMap[neighbour.ingredient.slug] = stockView(stockFor(stock, neighbour.ingredient.id));
      const overstock = items.some(isOverstocked);
      const filtersAvailable = {
        uses: USES.filter((use) => all.some((neighbour) => neighbour.ingredient.uses.includes(use))),
        evidence: EVIDENCE_TYPES.filter((type) => all.some((neighbour) => neighbour.evidence.some((entry) => entry.evidence_type === type))),
        relations: RELATIONS.filter((relation) => all.some((neighbour) => neighbour.relation === relation)),
        in_stock_only: true,
        existing_recipes: all.some((neighbour) => neighbour.evidence.some((entry) => entry.evidence_type === "atlas_learned")),
        use_soon: overstock,
        high_margin: isManagerActor(ctx.actor),
        low_complexity: true,
      };
      const inStock = result.neighbours.filter((neighbour) => neighbour.in_stock).length;
      return ok({
        summary: result.neighbours.length
          ? `${center.name} pairs with ${result.total} ingredient${result.total === 1 ? "" : "s"}${args.in_stock_only ? " in verified stock" : ""}; strongest: ${result.neighbours.slice(0, 4).map((neighbour) => `${neighbour.ingredient.name} (${neighbour.evidence_type === "atlas_learned" ? "Atlas recipes" : neighbour.evidence_type}, ${statusWord(neighbour.stock_status)})`).join(", ")}. ${inStock} of those listed are in verified stock.`
          : `No recorded pairings for ${center.name} match these filters.`,
        data: {
          center: { ...ingredientView(center), stock_status: centerEntry.status, in_stock: centerEntry.status === "available" },
          preparation: result.preparation,
          neighbours: result.neighbours,
          total: result.total,
          stock: stockMap,
          filters_available: filtersAvailable,
          basis: "Pairings are Atlas-curated culinary knowledge and co-occurrence in existing Atlas recipes; aroma/taste values marked 'profile' are calculated from the curated profiles.",
        },
        evidence: [
          ...stockEvidence(center, centerEntry),
          ...result.neighbours.slice(0, 12).map((neighbour) => pairingEvidence(center.name, neighbour.ingredient.name, neighbour)),
        ],
        records: stockRecords([centerEntry]),
        unknown: unknownStock(result.neighbours.map((neighbour) => stockFor(stock, neighbour.ingredient.id))),
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

const pairingsFromStock = {
  name: "flavor.pairings_from_stock",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Pairing what we have",
  description: "Pairs where BOTH ingredients are in verified current stock (optionally only partners of one ingredient), strongest first, with the Atlas items behind each side. Unknown, stale or needs-review stock is never used. Use for 'what goes together from what we have'.",
  parameters: S.object({
    ingredient: S.nullable(S.string("Only partners of this ingredient", { maxLength: 100 })),
    use: S.nullable(S.enum(USES, "Only pairs usable in this kind of drink or dish")),
    limit: S.nullable(S.integer("Maximum pairs (default 15)", { minimum: 1, maximum: 40 })),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock, recipes } = await loadFlavor(ctx);
      let only = null;
      if (args.ingredient) {
        const resolved = resolveOne(index, args.ingredient);
        if (resolved.clarification) return resolved.clarification;
        only = resolved.ingredient;
      }
      const available = index.ingredients.filter((ingredient) => stockFor(stock, ingredient.id).status === "available");
      const availableIds = new Set(available.map((ingredient) => ingredient.id));
      const pairs = new Map();
      for (const ingredient of only ? [only] : available) {
        for (const entry of edgesOf(index, ingredient.id, recipes)) {
          if (entry.edge.relation === "substitute" || !availableIds.has(entry.other) || (!only && !availableIds.has(ingredient.id))) continue;
          const other = index.byId.get(entry.other);
          if (args.use && !(ingredient.uses.includes(args.use) && other.uses.includes(args.use))) continue;
          const key = [ingredient.id, other.id].sort().join("|");
          const previous = pairs.get(key);
          if (previous && previous.strength >= entry.edge.strength) continue;
          pairs.set(key, {
            a: { slug: ingredient.slug, name: ingredient.name, items: stockFor(stock, ingredient.id).items.filter((item) => item.available).map((item) => item.name) },
            b: { slug: other.slug, name: other.name, items: stockFor(stock, other.id).items.filter((item) => item.available).map((item) => item.name) },
            relation: entry.edge.relation,
            strength: entry.edge.strength,
            evidence_type: entry.edge.evidence_type,
            confidence: entry.edge.confidence,
            explanation: entry.edge.explanation,
          });
        }
      }
      const rows = [...pairs.values()].sort((a, b) => b.strength - a.strength || a.a.name.localeCompare(b.a.name) || a.b.name.localeCompare(b.b.name));
      const limited = rows.slice(0, clampLimit(args.limit, 15, 40));
      const onlyEntry = only ? stockFor(stock, only.id) : null;
      if (only && onlyEntry.status !== "available") {
        return ok({
          summary: `${only.name} is ${statusWord(onlyEntry.status)}${onlyEntry.status === "unknown" ? ` (${onlyEntry.reason})` : ""}, so Atlas cannot pair it from verified stock.`,
          data: { pairs: [], total: 0, available_ingredients: available.length, ingredient_stock: stockView(onlyEntry) },
          evidence: stockEvidence(only, onlyEntry),
          records: stockRecords([onlyEntry]),
          unknown: unknownStock([onlyEntry]),
        });
      }
      const used = [...new Set(limited.flatMap((pair) => [pair.a.slug, pair.b.slug]))].map((slug) => index.bySlug.get(slug));
      return ok({
        summary: limited.length
          ? `${rows.length} pairing${rows.length === 1 ? "" : "s"} can be made entirely from verified stock (${available.length} ingredients in stock). Strongest: ${limited.slice(0, 4).map((pair) => `${pair.a.name} + ${pair.b.name}`).join(", ")}.`
          : `No recorded pairing has both sides in verified stock (${available.length} ingredients in stock).`,
        data: { pairs: limited, total: rows.length, available_ingredients: available.length },
        evidence: [
          ...used.slice(0, 8).flatMap((ingredient) => stockEvidence(ingredient, stockFor(stock, ingredient.id)).filter((entry) => entry.kind === "fact")),
          ...limited.slice(0, 8).map((pair) => pairingEvidence(pair.a.name, pair.b.name, pair)),
        ],
        records: stockRecords(used.map((ingredient) => stockFor(stock, ingredient.id))).slice(0, 30),
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

const substitutesTool = {
  name: "flavor.substitutes",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Finding substitutes",
  description: "What can replace an ingredient: recorded substitutes first (culinary evidence), then same-family ingredients with a similar aroma profile (calculated, labelled as such), each with how it differs (sweeter, less sour…), a practical adjustment and its verified stock status. in_stock_only keeps only substitutes in verified current stock.",
  parameters: S.object({
    ingredient: S.string("Ingredient to replace", { maxLength: 100 }),
    in_stock_only: S.nullable(S.boolean("Only substitutes in verified current stock")),
    limit: S.nullable(S.integer("Maximum substitutes (default 8)", { minimum: 1, maximum: 20 })),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock } = await loadFlavor(ctx, { withRecipes: false });
      const resolved = resolveOne(index, args.ingredient);
      if (resolved.clarification) return resolved.clarification;
      const original = resolved.ingredient;
      const result = buildSubstitutes(index, original, { stock, in_stock_only: args.in_stock_only === true, limit: clampLimit(args.limit, 8, 20) });
      const originalEntry = stockFor(stock, original.id);
      const entries = result.substitutes.map((row) => stockFor(stock, row.ingredient.id));
      return ok({
        summary: `${original.name} is ${statusWord(originalEntry.status)}${originalEntry.possible_matches.length ? ` (possible match ${originalEntry.possible_matches.map((item) => item.name).join(", ")} needs review; not counted)` : ""}. ${result.substitutes.length
          ? `Substitutes: ${result.substitutes.map((row) => `${row.ingredient.name} (${statusWord(row.stock_status)}${row.differences.length ? `; ${row.differences.join(", ")}` : ""})`).join("; ")}.`
          : "No substitute matches these filters."}`,
        data: { original: { ...ingredientView(original), stock: stockView(originalEntry) }, substitutes: result.substitutes, total: result.total },
        evidence: [
          ...stockEvidence(original, originalEntry),
          ...result.substitutes.slice(0, 8).map((row) => (row.basis === "recorded"
            ? interpretation(`Substitute (${EVIDENCE_LABEL[row.evidence_type] || row.evidence_type}): ${row.ingredient.name} for ${original.name}`, row.explanation, null)
            : calculation(`Profile similarity: ${row.ingredient.name} vs ${original.name}`, `aroma ${formatNumber(row.aroma_similarity * 100, 0)}%, taste ${formatNumber(row.taste_similarity * 100, 0)}% (calculated from flavour profiles)`, null))),
          ...result.substitutes.slice(0, 8).flatMap((row, position) => stockEvidence(index.byId.get(row.ingredient.id), entries[position])),
        ].slice(0, 30),
        records: stockRecords([originalEntry, ...entries]),
        unknown: unknownStock([originalEntry, ...entries]),
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

const CANDIDATE_PARAMETERS = {
  type: S.nullable(S.enum(CANDIDATE_TYPES, "Kind of idea; null = cocktails, mocktails and coffee drinks")),
  seed: S.nullable(S.array(S.string(null, { maxLength: 100 }), "Ingredients every idea must use", { minItems: 1, maxItems: 4 })),
  exclude_families: S.nullable(S.array(S.string(null, { maxLength: 40 }), "Families to leave out, e.g. 'citrus' (also removes citrus liqueurs and bitters)", { minItems: 1, maxItems: 8 })),
  exclude_ingredients: S.nullable(S.array(S.string(null, { maxLength: 100 }), "Ingredients to leave out", { minItems: 1, maxItems: 10 })),
  no_new_purchases: S.nullable(S.boolean("true (default) = only verified current stock; false = may include clearly marked to-buy ingredients")),
  goal: S.nullable(S.enum(GOALS, "Ordering goal (low_cost and high_margin are for managers)")),
};

async function resolveCandidateArgs(index, args) {
  const seedIds = [];
  for (const ref of args.seed || []) {
    const resolved = resolveOne(index, ref);
    if (resolved.clarification) return { clarification: resolved.clarification };
    seedIds.push(resolved.ingredient.id);
  }
  const excludeIds = [];
  for (const ref of args.exclude_ingredients || []) {
    const resolved = resolveOne(index, ref);
    if (resolved.clarification) return { clarification: resolved.clarification };
    excludeIds.push(resolved.ingredient.id);
  }
  return { seedIds, exclude: { families: (args.exclude_families || []).map((family) => family.toLowerCase().trim()), ingredient_ids: excludeIds } };
}

function candidateEvidence(candidate, manager) {
  const evidence = [];
  const risk = candidate.scores.inventory.low_stock_risk;
  const stockedLines = candidate.lines.filter((line) => !line.to_buy).length;
  if (candidate.composable) {
    evidence.push(calculation(`${candidate.name}: verified stock`, `${stockedLines} of ${candidate.lines.length} lines from verified current stock${risk?.servings_possible !== null && risk?.servings_possible !== undefined ? `; ${risk.servings_possible} serves possible${risk.limiting_item ? ` (limited by ${risk.limiting_item})` : ""}` : ""}`, null));
  }
  for (const name of candidate.to_buy) evidence.push(missing(`${name} for ${candidate.name}`, "not in verified stock — would need buying", null));
  const topPair = [...candidate.pairs].sort((a, b) => b.score - a.score)[0];
  if (topPair?.basis === "recorded") evidence.push(interpretation(`Pairing (${EVIDENCE_LABEL[topPair.evidence_type] || topPair.evidence_type}) in ${candidate.name}`, `${topPair.a_name} + ${topPair.b_name}: ${topPair.explanation}`, null));
  if (manager && candidate.scores.economics) {
    const economics = candidate.scores.economics;
    evidence.push(economics.cost_per_serve !== null
      ? calculation(`${candidate.name}: estimated cost per serve`, `${formatIsk(economics.cost_per_serve)}${economics.margin_at_price !== null ? `; theoretical margin ${formatNumber(economics.margin_at_price, 1)}% at ${formatIsk(economics.price_support.reference_price)} (${economics.price_support.basis})` : ""}`, null)
      : missing(`${candidate.name}: cost per serve`, economics.missing || "unknown", null));
  }
  return evidence;
}

const candidatesTool = {
  name: "flavor.candidates",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Working out ideas",
  description: "Ranked drink ideas built from bar templates (sour, collins, highball, stirred, old fashioned, spritz, coffee cocktail, cordial & soda, zero-proof sour, iced latte; dessert and food pairings as notes). By default every line is an Atlas item with verified current stock that covers a serve; unknown, stale and needs-review stock is never used. Every score dimension is returned: flavor (compatibility, balance, texture), inventory (coverage, low-stock risk, verified overstock), economics (cost per serve, margin at the median menu price; managers only), operations (steps, ingredients, equipment, batching) and menu (similarity to existing recipes, novelty). Returns a candidate_key per idea for recipes.compose_draft.",
  parameters: S.object({
    ...CANDIDATE_PARAMETERS,
    limit: S.nullable(S.integer("Number of ideas (default 5)", { minimum: 1, maximum: 10 })),
  }),
  async execute(args, ctx) {
    try {
      const manager = isManagerActor(ctx.actor);
      const { index, stock, items, recipes } = await loadFlavor(ctx);
      const resolved = await resolveCandidateArgs(index, args);
      if (resolved.clarification) return resolved.clarification;
      const noNewPurchases = args.no_new_purchases !== false;
      const result = buildCandidates(index, {
        stock, items, recipes,
        type: args.type,
        seed: resolved.seedIds,
        exclude: resolved.exclude,
        noNewPurchases,
        goal: args.goal || "balanced",
        limit: clampLimit(args.limit, 5, 10),
        includeEconomics: manager,
      });
      const rows = result.candidates.map((candidate) => ({
        ...candidate,
        compose_request: candidate.composable ? { candidate_key: candidate.key, type: candidate.type, no_new_purchases: noNewPurchases } : null,
      }));
      const seedNames = resolved.seedIds.map((id) => index.byId.get(id)?.name).filter(Boolean);
      const unmet = result.unmet_seeds;
      const unused = result.unused_seeds;
      const summaryParts = [];
      if (unmet.length) {
        summaryParts.push(`No ideas: ${unmet.map((seed) => `${seed.name} is ${seed.reason}`).join("; ")}.${noNewPurchases ? " Allowing new purchases would add it as a to-buy ingredient." : ""}`);
      } else if (unused.length && !rows.length) {
        summaryParts.push(`No ideas: ${unused.map((seed) => `${seed.name} is ${seed.reason}`).join("; ")}.`);
      } else if (rows.length) {
        summaryParts.push(`${rows.length} idea${rows.length === 1 ? "" : "s"}${seedNames.length ? ` with ${seedNames.join(" and ")}` : ""}${noNewPurchases ? " from verified current stock only" : ""}: ${rows.map((row) => `${row.name} (${row.template.name.toLowerCase()})`).join(", ")}.`);
      } else {
        summaryParts.push(result.notes[0] || "No ideas match these filters.");
      }
      if (result.notes.length && rows.length) summaryParts.push(result.notes.join(" "));
      if (result.unmeasurable.length) summaryParts.push(`${result.unmeasurable.length} item${result.unmeasurable.length === 1 ? "" : "s"} in verified stock could not be used because no package size is set.`);
      return ok({
        summary: summaryParts.join(" "),
        data: {
          candidates: rows,
          considered: result.considered,
          goal: result.goal,
          unmet_seeds: unmet,
          unused_seeds: unused,
          unmeasurable: result.unmeasurable,
          notes: result.notes,
          request: { type: args.type, seed: seedNames, exclude_families: resolved.exclude.families, no_new_purchases: noNewPurchases, goal: result.goal },
          basis: "Deterministic templates over verified stock; flavour compatibility from curated culinary pairings and Atlas recipes; cost from current inventory costs (theoretical).",
          engine_version: FLAVOR_ENGINE_VERSION,
        },
        evidence: [
          ...unmet.flatMap((seed) => {
            const ingredient = index.bySlug.get(seed.slug);
            return ingredient ? stockEvidence(ingredient, stockFor(stock, ingredient.id)) : [];
          }),
          ...unused.map((seed) => missing(`${seed.name} in a drink`, seed.reason, null)),
          ...rows.flatMap((candidate) => candidateEvidence(candidate, manager)),
          ...result.unmeasurable.slice(0, 5).map((item) => missing(`Package size of ${item.name}`, "not set or not readable, so a serve cannot be measured", source("inventory_item", item.item_id, item.name))),
        ].slice(0, 30),
        records: rows.flatMap((candidate) => candidate.lines.filter((line) => line.item_id).map((line) => record("inventory_item", line.item_id, line.item_name))).slice(0, 30),
        unknown: unmet.length
          ? { count: unmet.length, reason: "Requested ingredients without verified current stock" }
          : result.unmeasurable.length ? { count: result.unmeasurable.length, reason: "Items in verified stock without a package size cannot be measured" } : null,
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

const explainPair = {
  name: "flavor.explain_pair",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Explaining the pairing",
  description: "Why two ingredients do (or do not) go together: every recorded link between them with its evidence type (culinary, Atlas recipes), relation, strength, confidence and explanation, plus the calculated aroma and taste overlap of their profiles. Says plainly when no pairing is recorded; never presents a profile calculation as a recorded pairing.",
  parameters: S.object({
    a: S.string("First ingredient", { maxLength: 100 }),
    b: S.string("Second ingredient", { maxLength: 100 }),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock, recipes } = await loadFlavor(ctx);
      const first = resolveOne(index, args.a);
      if (first.clarification) return first.clarification;
      const second = resolveOne(index, args.b);
      if (second.clarification) return second.clarification;
      const a = first.ingredient;
      const b = second.ingredient;
      if (a.id === b.id) throw new ToolError("invalid_arguments", "Give two different ingredients.");
      const entries = edgesOf(index, a.id, recipes).filter((entry) => entry.other === b.id);
      const edges = entries.map((entry) => ({
        relation: entry.edge.relation, strength: entry.edge.strength, evidence_type: entry.edge.evidence_type, provider: entry.edge.provider,
        confidence: entry.edge.confidence, explanation: entry.edge.explanation, ...(entry.edge.recipes ? { recipes: entry.edge.recipes.map((recipe) => recipe.name) } : {}),
      })).sort((x, y) => y.strength - x.strength);
      const aroma = aromaSimilarity(a, b);
      const taste = tasteSimilarity(a, b);
      const shared = Object.keys(a.aroma).filter((key) => b.aroma[key]).sort();
      const best = bestEdge(index, a.id, b.id, recipes);
      const entryA = stockFor(stock, a.id);
      const entryB = stockFor(stock, b.id);
      return ok({
        summary: edges.length
          ? `${a.name} + ${b.name}: ${edges.map((edge) => `${edge.relation} (${EVIDENCE_LABEL[edge.evidence_type] || edge.evidence_type}, strength ${formatNumber(edge.strength)})`).join("; ")}. ${best?.edge.explanation || ""}`.trim()
          : `No recorded pairing between ${a.name} and ${b.name}. Their aroma profiles overlap ${formatNumber(aroma * 100, 0)}% (calculated, not evidence of a good pairing).`,
        data: {
          a: { ...ingredientView(a), stock_status: entryA.status },
          b: { ...ingredientView(b), stock_status: entryB.status },
          recorded: edges.length > 0,
          edges,
          profile: { aroma_similarity: aroma, taste_similarity: taste, shared_aroma_families: shared, basis: "calculated from Atlas-curated flavour profiles" },
        },
        evidence: [
          ...edges.map((edge) => pairingEvidence(a.name, b.name, edge)),
          ...(edges.length ? [] : [missing(`Recorded pairing: ${a.name} + ${b.name}`, "no culinary or Atlas-recipe evidence for this pair", null)]),
          calculation(`Aroma overlap: ${a.name} + ${b.name}`, `${formatNumber(aroma * 100, 0)}%${shared.length ? ` (shared: ${shared.map((key) => key.replace(/_/g, " ")).join(", ")})` : ""}`, null),
        ],
        records: stockRecords([entryA, entryB]),
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

const useSoonTool = {
  name: "flavor.use_soon",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Checking what to use up",
  description: "What should be used soon — answered honestly. Atlas does not record expiry, opening dates or shelf life, so freshness cannot be judged. The only verified signal is overstock: ingredients whose verified current count is at least twice their par level. Returns those (with the ingredients to seed flavor.candidates) and says what cannot be known.",
  parameters: S.object({
    limit: S.nullable(S.integer("Maximum items (default 15)", { minimum: 1, maximum: 40 })),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock, items } = await loadFlavor(ctx, { withRecipes: false });
      const rows = useSoon(index, stock, items).slice(0, clampLimit(args.limit, 15, 40));
      const linked = new Set(index.links.filter((link) => link.status === "confirmed").map((link) => link.inventory_item_id));
      const noPar = items.filter((item) => item.active !== false && linked.has(String(item.id)) && !(Number(item.par_level) > 0)).length;
      return ok({
        summary: `Atlas does not record expiry, opening dates or shelf life, so it cannot tell what must be used soon for freshness. ${rows.length
          ? `From verified counts, ${rows.length} ingredient item${rows.length === 1 ? " is" : "s are"} at or above twice par (overstock): ${rows.map((row) => `${row.item_name} (${formatNumber(row.verified_quantity)} ${row.unit || "units"}, par ${formatNumber(row.par_level)})`).join(", ")}.`
          : "No ingredient item is verified at twice its par level or more."}${noPar ? ` ${noPar} linked item${noPar === 1 ? " has" : "s have"} no par level and could not be judged.` : ""}`,
        data: {
          freshness_supported: false,
          freshness_reason: "No expiry, opened-date or shelf-life data exists in Atlas.",
          basis: "verified current count at or above twice a positive par level",
          overstock: rows,
          seed_ingredients: [...new Set(rows.map((row) => row.ingredient.slug))],
          not_judged_no_par: noPar,
        },
        evidence: [
          missing("Expiry and opened dates", "not recorded in Atlas; freshness cannot be judged", null),
          ...rows.map((row) => calculation(`Overstock: ${row.item_name}`, `verified ${formatNumber(row.verified_quantity)} ${row.unit || "units"} vs par ${formatNumber(row.par_level)} (${formatNumber(row.ratio_to_par)}×)`, source("inventory_item", row.item_id, row.item_name))),
        ],
        records: rows.map((row) => record("inventory_item", row.item_id, row.item_name)),
        unknown: noPar ? { count: noPar, reason: "Linked items without a par level cannot be judged for overstock" } : null,
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

// ---------------------------------------------------------------------------
// Draft: recipes.compose_draft → recipe.draft proposal
// ---------------------------------------------------------------------------

function methodText(draft) {
  return draft.method.map((step, position) => `${position + 1}. ${step}`).join("\n").slice(0, 4000);
}

function notesText(draft, snapshotVersion) {
  const parts = [
    `Drafted by Atlas Flavor Intelligence (${draft.template} template${snapshotVersion ? `, flavour library ${snapshotVersion}` : ""}).`,
    `Balance: sweet ${formatNumber(draft.balance.sweet)}, sour ${formatNumber(draft.balance.sour)}, dilution about ${draft.balance.dilution_pct}%, ABV about ${formatNumber(draft.balance.abv_est, 1)}%.`,
    draft.allergens.length ? `Allergens: ${draft.allergens.join(", ")}.` : null,
    "Pairing notes are culinary and Atlas-recipe evidence, not science. Taste and adjust before activating.",
  ];
  return parts.filter(Boolean).join(" ").slice(0, 2000);
}

const composeDraft = {
  name: "recipes.compose_draft",
  level: "draft",
  roles: MANAGERS,
  specialist: "recipes",
  progress: "Preparing a draft recipe",
  description: "Manager only. Turns one idea from flavor.candidates (its candidate_key) into a complete draft recipe spec — quantities from bar ratios, method, glass, garnish, dilution, estimated ABV, cost per serve — re-checked against current verified stock (every item must still be in verified stock and cover one serve). Prepares a proposal card; on approval Atlas saves a NEW inactive recipe in Recipes › Drafts (never on the menu, never changing existing recipes, stock or purchasing).",
  parameters: S.object({
    candidate_key: S.string("candidate_key from flavor.candidates", { maxLength: 1200 }),
    type: S.nullable(S.enum(DRINK_TYPES, "Recipe type if the idea fits several")),
    no_new_purchases: S.nullable(S.boolean("false only if the idea includes to-buy ingredients the manager accepted")),
    name: S.nullable(S.string("Recipe name if the manager chose one", { maxLength: 120 })),
  }),
  async execute(args, ctx) {
    try {
      const { index, stock, items, recipes, snapshot } = await loadFlavor(ctx);
      const noNewPurchases = args.no_new_purchases !== false;
      const candidate = candidateFromKey(index, args.candidate_key, { stock, items, recipes, noNewPurchases, includeEconomics: true, type: args.type });
      const draft = compose(index, candidate, { items, recipes, name: args.name, includeEconomics: true });
      const lineCosts = Object.fromEntries((draft.costing?.line_costs || []).filter((line) => line.item_id && Number.isFinite(line.cost)).map((line) => [line.item_id, line.cost]));
      const command = {
        client_request_id: typeof ctx.newId === "function" ? ctx.newId() : newId(),
        recipe: {
          name: draft.name,
          type: draft.type,
          glassware: draft.glass,
          garnish: draft.garnish,
          method: methodText(draft),
          notes: notesText(draft, snapshot?.version ? String(snapshot.version) : null),
          yield_quantity: 1,
          yield_unit: "serving",
          menu_price: null,
          active: false,
          show_on_menu: false,
        },
        ingredients: draft.lines.map((line) => ({
          item_id: line.to_buy ? null : line.item_id,
          item_name: line.item_name,
          quantity: line.quantity,
          unit: line.unit,
          role: line.role,
          to_buy: line.to_buy,
        })),
        source: {
          candidate_key: candidate.key,
          engine_version: FLAVOR_ENGINE_VERSION,
          snapshot_version: snapshot?.version ? String(snapshot.version).slice(0, 80) : null,
        },
      };
      const costing = draft.costing;
      const evidence = [
        ...draft.lines.filter((line) => !line.to_buy).map((line) => {
          const item = items.find((candidateItem) => String(candidateItem.id) === line.item_id);
          return fact(`Current stock of ${line.item_name}`, `${formatNumber(Number(item?.verified_quantity))} ${item?.unit || "units"} (verified count)`, source("inventory_item", line.item_id, line.item_name));
        }),
        ...draft.lines.filter((line) => line.to_buy).map((line) => missing(`${line.item_name} stock`, "not in verified stock — to buy", null)),
        ...(draft.servings_possible !== null ? [calculation(`Serves of ${draft.name} from verified stock`, `${draft.servings_possible}`, null)] : []),
        ...(costing?.cost_per_serve !== null && costing?.cost_per_serve !== undefined
          ? [calculation(`${draft.name}: estimated cost per serve`, formatIsk(costing.cost_per_serve), null)]
          : [missing(`${draft.name}: cost per serve`, costing?.missing || "unknown", null)]),
        ...(costing?.margin_at_price !== null && costing?.margin_at_price !== undefined
          ? [calculation(`${draft.name}: theoretical margin`, `${formatNumber(costing.margin_at_price, 1)}% at ${formatIsk(costing.price_support.reference_price)} (${costing.price_support.basis}); no menu price is set on the draft`, null)]
          : []),
        ...candidate.pairs.filter((pair) => pair.basis === "recorded").slice(0, 4).map((pair) => interpretation(`Pairing (${EVIDENCE_LABEL[pair.evidence_type] || pair.evidence_type}): ${pair.a_name} + ${pair.b_name}`, pair.explanation, null)),
      ];
      const warnings = draft.checks.filter((check) => !check.ok && check.key !== "verified_stock").map((check) => check.detail);
      const proposal = buildProposal("recipe.draft", command, {
        title: `Save draft recipe "${draft.name}"`,
        summary: `Draft recipe "${draft.name}" (${draft.lines.length} lines) for approval. It is saved inactive in Recipes › Drafts only after approval.`,
        subjectType: "recipe",
        subjectKey: draft.name,
        evidence,
        extras: { lineCosts, costPerServe: draft.costing?.cost_per_serve, includeCost: true, warnings },
      });
      return ok({
        summary: `Prepared "${draft.name}" (${draft.technique}, ${draft.glass}): ${draft.lines.map((line) => line.display).join(", ")}. ${costing?.cost_per_serve !== null && costing?.cost_per_serve !== undefined ? `Estimated cost ${formatIsk(costing.cost_per_serve)} per serve. ` : ""}Approve the card to save it as an inactive draft in Recipes; nothing has been saved yet.`,
        data: { draft, costing: costing ?? null },
        evidence: evidence.slice(0, 20),
        records: draft.lines.filter((line) => line.item_id).map((line) => record("inventory_item", line.item_id, line.item_name)),
        proposal,
      });
    } catch (error) {
      throw flavorFailure(error);
    }
  },
};

export const FLAVOR_TOOLS = [
  searchIngredientsTool, ingredientProfile, pairingsTool, pairingsFromStock, substitutesTool, candidatesTool, explainPair, useSoonTool, composeDraft,
];
