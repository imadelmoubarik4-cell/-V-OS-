# Atlas Flavor Intelligence — Engine, tools and routes

Code: `supabase/functions/_shared/ai-tools/flavor-graph.mjs` (pure engine),
`tools-flavor.mjs` (registry tools), `actions.mjs` (`recipe.draft`),
`services.mjs` (`flavorSnapshot`, `recipeSaveDraft`),
`supabase/functions/atlas-ai/handler.mjs` (JSON routes).
Tests: `tests/node/ai-tools-flavor.test.js`, `tests/node/atlas-ai-flavor-routes.test.js`,
`tests/ai-evals/cases/flavor.json`, fixture `tests/node/helpers/flavor-fixtures.js`.
Data and schema: `docs/flavor/Schema.md`, `docs/flavor/Mapping_Report.md`.

## 1. What it guarantees

| Rule | How |
| --- | --- |
| Production inventory is read only | The engine and tools only read. The single write is `recipe.draft` on a manager's approval: a **new** inactive recipe through `public.atlas_save_recipe(p_recipe_id := null, …)` with the approver's JWT, `active = false`, `show_on_menu = false` forced in both `actions.mjs` and `services.recipeSaveDraft`. Existing recipes, menus, stock, items, suppliers and purchasing are never touched. |
| Only verified current stock is available | An ingredient is `available` only through a **confirmed** link to an item whose projected stock (`services.projectedItems()` = `atlas-domain projectStock`) passes `isStockKnown` (freshness `current` from `currentQuantityEvidence`) with a quantity above zero. This is the same evidence `inventory.current_stock` reports as `quantity_status: 'current'` (`buildStockReport`); a test asserts the two agree item by item. Unknown ≠ 0; stale, historical and never-counted items are `unknown`; `inventory_items.quantity` is never read as stock; inactive items never count. |
| Uncertain matches never count | `needs_review` links appear only as `possible_matches` (`counted_as_stock: false`); an ingredient whose only link needs review is `unknown`, even if that item has a verified count. |
| No invented items or quantities | Every recipe line is an Atlas inventory item taken from the verified stock map, or — only when `no_new_purchases` is `false` — a line marked `to_buy: true` with `item_id: null`. Quantities come from template ratios; a line is used only if canonical `recipeMetrics` says verified stock covers at least one serve (`batches ≥ 1`). Candidate keys are re-validated against current links and stock on compose; forged or stale keys are refused (`conflict`). |
| Evidence stays distinct | Edge `evidence_type` ∈ `scientific \| culinary \| atlas_learned \| ai_interpretation`. MVP data is `culinary` (provider `atlas_curated`) and `atlas_learned` (computed here from active Atlas recipes). The engine never labels anything scientific; profile similarity is a **calculation** (basis `profile`), never a recorded pairing. Tool evidence: `fact` for verified stock, `calculation` for serves/cost/margin/overlap, `interpretation` for pairing notes (labelled with their evidence type), `missing` for unknown stock, unset package sizes and absent expiry data. |
| Staff never see cost | Economics are computed only for admin/manager (`includeEconomics`); staff get `scores.economics: null`, no cost evidence, and the gateway redaction runs on top. `recipes.compose_draft` is manager-only. |

## 2. Inputs

`atlas_flavor_snapshot()` (served by `services.flavorSnapshot()`, service role,
role gate re-applied on every call, 5-minute per-isolate cache per project,
`clearFlavorSnapshotCache()` for tests):
`{version, sources[], ingredients[], aliases[], preparations[], ingredient_preparations[], edges[], links[]}`.
The index accepts preparation references as ids (`preparation_id`, `a_prep`)
or slugs (`preparation`, `a_prep`/`b_prep` as returned by the SQL), taste keys
`fat`/`fat_rich` and `alcohol`/`alcohol_heat`, and drops invalid rows (unknown
relation or evidence type, self-edges, rejected links, dangling ids).

Also: `services.projectedItems()` (stock), `services.stockReport()` (freshness
labels stale / historical / unverified) and `services.recipes()` (co-occurrence,
menu similarity, reference prices; staff read `recipe_catalog`).

## 3. Engine (`flavor-graph.mjs`)

* `indexSnapshot(snapshot)` — lookup maps, undirected adjacency, folded search keys.
* `searchIngredients(index, query, {limit, uses})` — folded names, slugs and aliases
  (Icelandic included via `product-identity foldText`); scores exact 1, prefix 0.85,
  all words 0.7, fuzzy (1 edit for words ≥ 4 letters, 2 for ≥ 8) 0.5.
  `resolveIngredient` returns `unique | ambiguous | none` and never guesses between ties.
* `stockByIngredient(index, projectedItems, {reportRows})` →
  `Map<ingredient_id, {status: available|out|unknown|not_stocked, reason, items[], possible_matches[]}>`;
  `stockFor()` gives `not_stocked` for unlinked ingredients.
* `learnedEdges(index, recipes)` — pairs of ingredients (through confirmed links) used
  together in **active** recipes: relation `complement`, `strength = min(0.9, 0.45 + 0.15·n)`,
  `confidence = min(0.9, 0.5 + 0.1·n)`, `evidence_type: atlas_learned`, provider `atlas_recipes`,
  explanation names the recipes. Inactive/draft recipes are not evidence.
* `pairings(index, ingredient, {prep, filters:{use, in_stock_only, evidence, relation}, limit, stock, recipes})`
  — neighbours grouped per ingredient, strongest link first, every link kept in `evidence[]`.
  Dims: `strength` (edge), `aroma` and `taste` (recorded edge score, else calculated profile
  similarity: aroma cosine; taste `1 − mean|Δ|/5`), `texture` (recorded only, else `null`),
  with `dims_basis` saying which.
* `substitutes(index, ingredient, {stock, in_stock_only, limit})` — recorded `substitute`
  edges first, then same-family, same-alcohol-status ingredients with aroma similarity ≥ 0.5
  (score `(0.6·aroma + 0.4·taste)`, ×0.8 across subfamilies; basis `profile`). Each row lists
  taste `differences` (≥ 1.5 points: sweeter, less sour, …) and practical `adjustments`.
* `candidates(index, {stock, items, recipes, type, seed, exclude, noNewPurchases, goal, limit, includeEconomics})`
  — see §4. `compose(index, candidate, …)` and `candidateFromKey(index, key, …)` — see §5.
* `useSoon(index, stock, items)` — verified overstock only (count ≥ 2 × a positive par).

### Templates

| Template | Types | Roles (ml per serve; optional in italics) | Glass | Technique, dilution | Batching |
| --- | --- | --- | --- | --- | --- |
| `sour` | cocktail | base spirit 50, sour 25, sweet 20 (tuned), *bitters 1* | Coupe | shaken, 22% | partial |
| `collins` | cocktail | base 45, sour 25, sweet 15 (tuned), top 60 | Collins | shaken + topped, 15% | partial |
| `highball` | cocktail | base 45, top 120, *sour 10* | Highball | built, 10% | partial |
| `stirred` | cocktail | base 45, modifier (liqueur / fortified wine) 25, *bitters 1* | Nick & Nora | stirred, 20% | batchable |
| `old_fashioned` | cocktail | aged spirit 50, plain sweetener 7.5, bitters 1.5 | Rocks | stirred, 20% | batchable |
| `spritz` | cocktail | aperitif 50, sparkling wine 75, top 25 | Wine glass | built, 8% | partial |
| `coffee_cocktail` | cocktail, coffee | spirit 40, espresso (18 g beans or 30 ml), sweet 20, *milk 15* | Coupe | shaken, 20% | not batchable |
| `cordial_soda` | mocktail | fruit/flower/herb syrup or cordial 30, top 120, *sour 10* | Highball | built, 10% | partial |
| `zero_sour` | mocktail | fruit 45, sour 25, non-alcoholic sweetener 15 (tuned) | Coupe | shaken, 20% | partial |
| `iced_latte` | coffee | espresso, milk 150, non-alcoholic sweet 15 | Tumbler | built, 10% | not batchable |
| `dessert_pairing` / `food_pairing` | dessert / food | pairing notes only (not composable) | — | — | — |

Role selectors work on family, subfamily, effective taste (ingredient taste +
preparation `taste_shift`) and alcohol: e.g. *sour* = citrus/fruit with sour ≥ 4 and
not a sweet preparation; *sweet* = sweetener, sweet preparation (syrup, cordial, shrub,
oleo-saccharum) or liqueur with sweet ≥ 3.5 (solid sugar only in the old fashioned);
*top* = non-alcoholic carbonated mixer; mocktail and latte templates reject any alcoholic
ingredient. Sour-family sweet quantities are tuned to sweet:sour ≈ 0.85 (2.5 ml steps,
10–30 ml, liqueurs ≤ 25 ml) only if verified stock still covers the tuned serve.

Quantities are expressed in the chosen item's own unit so the canonical stock math
applies: ml (size_ml, `l`, `ml` units), g (`kg`/`g` items: syrups, purées and milk at
1 ml ≈ 1 g; raw produce by weight never fills a liquid role), whole fruit `each`
(30 ml juice per citrus, 50 ml per other fruit; never packs of juice/purée), garnish
0.125 citrus or 0.05 bunch of herbs. An item whose unit cannot express the serve
(e.g. `units`/`bottles` without a package size) is skipped and reported in
`unmeasurable` — it is never guessed.

## 4. Candidates and scoring

For each template of the requested type(s), each required role gets a pool of up to 6
options (one per ingredient, best preparation first) ranked by availability, seed
membership, recorded compatibility with the seeds and role fit. The Cartesian product
is filtered (distinct ingredients, every seed present, exclusions applied — excluding
a family such as `citrus` also removes `citrus_*` subfamilies like orange liqueur and
orange bitters), each line must pass the serve check, optional roles are added only
from verified stock with compatibility ≥ 0.55, and a garnish is chosen from whole
citrus or herbs in verified stock that pair with the drink (none for coffee drinks).
Combinations with flavour compatibility below `MIN_COMPATIBILITY = 0.4` are dropped.

Every candidate returns all dimensions (there is no single opaque score):

| Group | Dimension | Definition |
| --- | --- | --- |
| flavor | `compatibility` | Mean over ingredient pairs (neutral soda excluded) of the best recorded link strength (culinary or Atlas recipes); an unrecorded pair counts `0.5 × aroma similarity` (basis `profile`). All pairs are listed in `pairs[]`. |
| flavor | `balance` | `sour_ratio`: sweet:sour (Σ ml×sweet / Σ ml×sour) 0.6–1.2 scores 1, else log decay; `bittersweet`: sweet share of sweet+bitter vs 0.65; `coffee`: vs 0.5; `light`: sweetness density 0.3–1.6. `balance_note` states the value. |
| flavor | `texture` | Template fit (carbonation present, milk for creamy, shaken foam, syrupy body), averaged 50/50 with recorded edge texture scores when present; `null` for pairings. |
| inventory | `coverage` | Share of lines from verified stock (1 unless to-buy lines are allowed). |
| inventory | `low_stock_risk` | `{level: high < 6 serves ≤ medium < 20 ≤ low, servings_possible, limiting_item}` from canonical `recipeMetrics` availability. |
| inventory | `use_soon` | `{supported, overstock_lines, basis}` — lines drawn from verified overstock (≥ 2 × par). No expiry data exists. |
| economics (managers) | `cost_per_serve`, `margin_at_price`, `price_support`, `missing` | Canonical `recipeMetrics` cost over current inventory costs; margin at the **reference price** = median menu price of active recipes of the same kind (`price_support.basis` says how many). Unknown (with reason) if any cost is missing or a line is to buy. Theoretical only. |
| operations | `steps`, `ingredient_count`, `equipment`, `batching` | From the template. |
| menu | `similarity`, `novelty`, `closest_recipe` | Jaccard overlap of canonical ingredients with existing recipes; novelty = 1 − similarity. |

`rank = {key, goal, weights}` is only an ordering key. Goals and weights:
`balanced` (compatibility .35, balance .2, texture .1, coverage .2, novelty .1, simplicity .05),
`use_stock` (coverage .35, compatibility .3, balance .15, use_soon .1, servings .1),
`low_cost` (cost .45 = 1 − cost/max cost, compatibility .3, balance .25),
`high_margin` (margin .45, compatibility .3, balance .25),
`novel` (novelty .4, compatibility .35, balance .25), `simple` (simplicity .4, compatibility .35, balance .25).
`low_cost`/`high_margin` fall back to `balanced` for staff (and say so). The returned list
is diversified: at most two per template, no two with the same name, no ingredient sets
overlapping ≥ 75%.

Result: `{candidates, considered, goal, unmet_seeds, unused_seeds, unmeasurable, notes}`.
`unmet_seeds` = requested ingredients with no usable stock (not stocked, verified out,
unknown, needs review, excluded); `unused_seeds` = in stock but fitting no idea, with the
honest reason (only whole produce, package size not set, no pairing with enough stock).

## 5. Candidate keys and composition

`key = v1|<template>|<role>=<ingredient-slug>~<prep-slug or ->@<item uuid | buy>|…`
(garnish included). `candidateFromKey` rebuilds the idea against **current** data: the
template and every ingredient/preparation must exist, every item must be a confirmed link
of that ingredient/preparation with verified stock covering the serve now, `buy` needs
`no_new_purchases: false`, every role must still accept the ingredient. Otherwise it throws
`FlavorError` (`conflict` / `invalid_arguments` / `not_supported` for dessert/food).

`compose(index, candidate, {items, recipes, name, includeEconomics})` →
`{name, type (Cocktail|Mocktail|Coffee), template, glass, technique, method[], garnish,
yield: {quantity: 1, unit: 'serving'}, lines: [{item_id, item_name, quantity, unit, role,
display, to_buy, ingredient_slug}], balance: {sweet, sour, bitter, dilution_pct, abv_est,
volume_ml, final_volume_ml}, servings_possible, allergens, checks[], candidate_key, costing?}`.
Lines for the same item are merged (a lemon juiced and used as peel is one line), because
`recipe_ingredients` is unique per recipe and item. ABV estimate = Σ(ml × abv) ÷ (ml × (1 +
dilution)). Checks: `no_invented_items`, `verified_stock` (false when to-buy lines exist),
`serve_within_stock`, `balance`, `alcohol_free` (mocktail/latte), `allergens`, `name_unique`
(names already used get “No. 2”). Output is deterministic for the same inputs.

## 6. Tools (specialist `recipes`)

| Tool | Level / roles | Arguments (strict; `?` = nullable) | Returns (data) |
| --- | --- | --- | --- |
| `flavor.search_ingredients` | read, A M B V | `query`, `use?`, `limit?` | `results[{…ingredient, match, matched_text, score, stock_status, in_stock}]` |
| `flavor.ingredient_profile` | read, all | `ingredient` | `ingredient{aroma, taste, texture, abv_typical, allergens, dietary, preparations…}`, `stock`, `recipes_using`, `top_pairings` |
| `flavor.pairings` | read, all | `ingredient?` (null = best-connected in-stock), `preparation?`, `use?`, `in_stock_only?`, `evidence?[]`, `limit?` | `center`, `neighbours[]` (dims, evidence), `stock{slug: …}`, `filters_available` |
| `flavor.pairings_from_stock` | read, all | `ingredient?`, `use?`, `limit?` | `pairs[{a, b, relation, strength, evidence_type, explanation}]` with both sides in verified stock |
| `flavor.substitutes` | read, all | `ingredient`, `in_stock_only?`, `limit?` | `original{…, stock}`, `substitutes[]` |
| `flavor.candidates` | read, all (economics managers only) | `type?`, `seed?[]`, `exclude_families?[]`, `exclude_ingredients?[]`, `no_new_purchases?` (default true), `goal?`, `limit?` | `candidates[]` (each with `compose_request {candidate_key, type, no_new_purchases}`), `unmet_seeds`, `unused_seeds`, `unmeasurable`, `notes`, `request` |
| `flavor.explain_pair` | read, all | `a`, `b` | `recorded`, `edges[]`, `profile{aroma_similarity, taste_similarity, shared_aroma_families}` |
| `flavor.use_soon` | read, all | `limit?` | `freshness_supported: false`, `freshness_reason`, `overstock[]`, `seed_ingredients[]`, `not_judged_no_par` |
| `recipes.compose_draft` | **draft**, A M | `candidate_key`, `type?`, `no_new_purchases?`, `name?` | `draft`, `costing`; `proposal` of kind `recipe.draft` |

Ambiguous names return `data.needs_clarification` (the model asks which one). A missing
snapshot RPC yields `unavailable` ("The flavour library is not available right now").

### `recipe.draft` proposal kind

Roles admin/manager, executable. Strict command:
`{client_request_id, recipe{name, type: Cocktail|Mocktail|Coffee, glassware?, garnish?, method,
notes?, yield_quantity, yield_unit: 'serving', menu_price? (always null from Atlas), active,
show_on_menu}, ingredients[1..20]{item_id?, item_name, quantity, unit (ml g each bottle can
bunch l kg tsp tbsp), role, to_buy}, source{candidate_key, engine_version, snapshot_version?}}`
plus rules: a to-buy line has no item id, a stocked line has one, no repeated item. Preview:
one line per ingredient (`"50 ml = 307 kr"` for the approving manager), glass, garnish,
method, estimated cost per serve, warnings (to-buy lines), `will_change` (new inactive draft
in Recipes › Drafts), `will_not_change` (not on service/menu, no existing recipe, stock,
items, costs, suppliers or purchasing change). Execute: name pre-check against
`services.recipes()` then `recipeSaveDraft` with the approver's JWT; a used name (pre-check
or `23505`/409 from `recipes_name_key`) → `name_taken` with a clear message (mapped in the
atlas-ai `ACTION_ERROR_MESSAGES`). Result: `record('recipe', id, name)` → `#recipes/<id>`.
The SQL allow-list must include `recipe.draft` (migration `…_s95b_recipe_draft_kind.sql`).

## 7. atlas-ai routes

All four are JSON actions of the existing `atlas-ai` function (`?action=`), need a signed-in
active Atlas profile (Bearer JWT), **do not** need an OpenAI key or the Atlas AI switch
(no model call, no turn counted), and run the tools through `gateway.runTool` (role check,
strict arguments, redaction). Each call writes one `ai_tool_calls` audit row (no run or
conversation). Per-person limit: 60 flavour requests a minute per isolate (`429 rate_limited`).
Tool failures map to HTTP: `forbidden` 403, `invalid_arguments` 400, `not_found` 404,
`conflict` 409, `limit_exceeded` 429, anything else 503 `unavailable`; body
`{"error_code": "...", "message": "..."}`. Every success body also carries
`summary`, `evidence[]`, `records[]`, `unknown`. Ambiguous names return
`{"needs_clarification": [{query, status: "ambiguous", candidates: [{slug, name}]}], …}`.

**`GET ?action=flavor-map&ingredient=<slug|name>&preparation=&use=&in_stock_only=true&evidence=culinary,atlas_learned&limit=24`**
(all parameters optional; no ingredient = best-connected ingredient in verified stock)

```json
{
  "center": { "id": "…", "slug": "london-dry-gin", "name": "London dry gin", "family": "spirit", "subfamily": "gin",
              "uses": ["cocktail"], "intensity": 4, "alcoholic": true, "stock_status": "available", "in_stock": true },
  "preparation": null,
  "nodes": [
    { "slug": "london-dry-gin", "name": "London dry gin", "family": "spirit", "subfamily": "gin", "uses": ["cocktail"],
      "stock_status": "available", "in_stock": true, "center": true },
    { "slug": "lemon", "name": "Lemon", "family": "citrus", "subfamily": "citrus", "uses": ["cocktail", "mocktail", "dessert", "food"],
      "stock_status": "available", "in_stock": true, "center": false }
  ],
  "edges": [
    { "source": "london-dry-gin", "target": "lemon", "relation": "complement", "strength": 0.9, "aroma": 0.642, "taste": 0.775,
      "texture": null, "dims_basis": { "aroma": "profile", "taste": "profile", "texture": "not recorded" },
      "evidence_type": "culinary", "confidence": 0.7, "explanation": "Citrus peel in the gin echoes fresh lemon; …",
      "provider": "atlas_curated",
      "evidence": [ { "relation": "complement", "strength": 0.9, "evidence_type": "culinary", "provider": "atlas_curated", "confidence": 0.7, "explanation": "…" } ] }
  ],
  "stock": { "london-dry-gin": { "status": "available", "reason": "verified current count above zero",
             "items": [ { "item_id": "…", "name": "Beefeater Gin", "unit": "bottle", "verified_quantity": 5, "freshness": "current", "available": true, "preparation": null } ],
             "possible_matches": [] } },
  "filters_available": { "uses": ["cocktail", "mocktail", "dessert", "food"], "evidence": ["culinary", "atlas_learned"],
                         "relations": ["complement"], "in_stock_only": true, "existing_recipes": true,
                         "use_soon": false, "high_margin": true, "low_complexity": true },
  "total": 13, "basis": "…", "summary": "…", "evidence": [], "records": [], "unknown": null
}
```
`nodes[0]` is the centre; `nodes.length = edges.length + 1`. `filters_available.use_soon` is
true only when some linked item is verified at ≥ 2 × par; `high_margin` only for managers.

**`GET ?action=flavor-search&q=<text>&use=&limit=`** (`q` required, else 400)
→ `{ "results": [ { "id", "slug", "name", "family", "subfamily", "uses", "intensity", "alcoholic", "match": "exact|prefix|words|fuzzy", "matched_text", "score", "stock_status", "in_stock" } ], "total": 1, "summary", "evidence", "records", "unknown" }`

**`POST ?action=flavor-candidates`**

```json
{ "type": "cocktail", "seed": ["cognac"], "exclude": { "families": ["citrus"], "ingredients": ["amaretto"] },
  "no_new_purchases": true, "goal": "balanced", "limit": 3 }
```
(all optional; `type` ∈ cocktail, mocktail, coffee, dessert, food, null = drinks;
`goal` ∈ balanced, use_stock, low_cost, high_margin, novel, simple)
→
```json
{ "candidates": [ {
    "key": "v1|old_fashioned|base=cognac~-@<item>|sweet=vanilla~syrup@<item>|bitters=aromatic-bitters~-@<item>",
    "template": { "key": "old_fashioned", "name": "Old Fashioned", "technique": "stirred", "glass": "Rocks" },
    "type": "cocktail", "name": "Vanilla Cognac Old Fashioned", "composable": true,
    "ingredients": [ { "role": "base", "slug": "cognac", "name": "Cognac", "family": "spirit", "preparation": null,
                       "item": { "id": "…", "name": "Hennessy VS Cognac" }, "to_buy": false, "stock_status": "available" } ],
    "lines": [ { "role": "base", "item_id": "…", "item_name": "Hennessy VS Cognac", "quantity": 50, "unit": "ml", "display": "50 ml Hennessy VS Cognac", "to_buy": false } ],
    "scores": { "flavor": { "compatibility": 0.8, "balance": 0.9, "texture": 0.85 },
                "inventory": { "coverage": 1, "low_stock_risk": { "level": "medium", "servings_possible": 18, "limiting_item": "Hennessy VS Cognac" },
                               "use_soon": { "supported": true, "overstock_lines": 0, "basis": "…" } },
                "economics": { "cost_per_serve": 617, "margin_at_price": 78.7,
                               "price_support": { "reference_price": 2900, "comparable_count": 5, "basis": "median menu price of 5 active cocktail recipes" }, "missing": null },
                "operations": { "steps": 4, "ingredient_count": 3, "equipment": ["mixing glass", "bar spoon", "jigger", "julep strainer"], "batching": "batchable" },
                "menu": { "similarity": 0.2, "novelty": 0.8, "closest_recipe": { "id": "…", "name": "Sidecar", "active": true } } },
    "pairs": [ { "a": "cognac", "b": "vanilla", "a_name": "Cognac", "b_name": "Vanilla", "score": 0.85, "basis": "recorded", "evidence_type": "culinary", "relation": "complement", "explanation": "…", "provider": "atlas_curated", "confidence": 0.7 } ],
    "balance_note": "sweet share 0.6 of sweet+bitter (target 0.65)", "to_buy": [],
    "rank": { "key": 0.79, "goal": "balanced", "weights": { "compatibility": 0.35, "balance": 0.2, "texture": 0.1, "coverage": 0.2, "novelty": 0.1, "simplicity": 0.05 } },
    "compose_request": { "candidate_key": "v1|old_fashioned|…", "type": "cocktail", "no_new_purchases": true } } ],
  "considered": 11, "goal": "balanced", "unmet_seeds": [], "unused_seeds": [], "unmeasurable": [], "notes": [],
  "request": { "type": "cocktail", "seed": ["Cognac"], "exclude_families": ["citrus"], "no_new_purchases": true, "goal": "balanced" },
  "basis": "…", "summary": "…", "evidence": [], "records": [], "unknown": null }
```
For bartenders and viewers `scores.economics` is `null` and no cost appears anywhere.

**`POST ?action=flavor-compose`** (managers; bartenders/viewers → 403)

```json
{ "candidate": { "candidate_key": "v1|…", "type": "cocktail", "no_new_purchases": true }, "name": null }
```
(`candidate` is the idea's `compose_request`, passed back verbatim; `candidate.key` is also accepted)
→
```json
{ "proposal": { "id": "<ai_actions uuid>", "kind": "recipe.draft", "title": "Save draft recipe \"Orange Gin Sour\"",
                "preview": { "headline": "Draft recipe \"Orange Gin Sour\"",
                             "lines": [ { "label": "Beefeater Gin", "detail": "50 ml = 307 kr" }, { "label": "Glass", "detail": "Coupe" }, { "label": "Method", "detail": "1. Chill a coupe.\n2. …" } ],
                             "totals": { "lines": 3, "estimated_total": 542, "estimated_total_label": "542 kr per serve (estimated)" },
                             "recipients": [], "warnings": [],
                             "will_change": ["A new recipe \"Orange Gin Sour\" is saved in Recipes › Drafts (inactive)."],
                             "will_not_change": ["It is not on service and not on the menu until a manager activates it in Recipes.", "No existing recipe is changed.", "Stock, items, costs, suppliers and purchasing do not change."],
                             "route": "#recipes" },
                "required_roles": ["admin", "manager"], "expires_at": "…", "status": "proposed" },
  "draft": { "name": "Orange Gin Sour", "type": "Cocktail", "template": "sour", "glass": "Coupe", "technique": "shaken", "method": ["…"],
             "garnish": "lemon peel (Lemons)", "yield": { "quantity": 1, "unit": "serving" }, "lines": [ … ],
             "balance": { "sweet": 1, "sour": 1.25, "bitter": 1, "dilution_pct": 22, "abv_est": 25.8, "volume_ml": 100, "final_volume_ml": 122 },
             "servings_possible": 28, "allergens": [], "checks": [ … ], "candidate_key": "v1|…", "costing": { … } },
  "summary": "…", "evidence": [ … ], "records": [ … ], "unknown": null }
```
The proposal is stored with `atlas_ai_action_create(p_conversation_id := null, p_message_id := null, …)`
and recorded with `atlas_ai_record_proposal`, exactly as chat proposals are. The UI approves it with
the unchanged `POST ?action=execute-action {"action_id": "<proposal.id>"}` →
`{ok: true, action, result: {summary, data: {recipe_id, active: false, show_on_menu: false, to_buy}, records: [{type: "recipe", id, label, route: "#recipes/<id>"}]}}`;
a used name → `{ok: false, error: {code: "name_taken", message: "A recipe with this name already exists, …"}}`;
the idea no longer possible from verified stock → 409 from `flavor-compose`.

## 8. "Use soon"

Atlas records no expiry, opening date or shelf life, so freshness cannot be judged and the
tool says so (`freshness_supported: false`, `missing` evidence). The only verified signal is
overstock — a verified current count ≥ 2 × a positive par — returned as `overstock[]` and as
`seed_ingredients` for `flavor.candidates`; linked items without a par are counted as not judged.

## 9. Limits and known gaps

* Flavour vectors, pairings and templates are curated culinary estimates, not laboratory
  data. Ratios are classic bar starting points; the draft note says to taste and adjust.
* Unit coverage: items without a readable package size (`units`, `packs`, `bottles` with no
  `size_ml`) cannot be measured and are listed in `unmeasurable`; whole produce by weight
  never fills a liquid role (a syrup or juice must exist as its own stocked item/preparation).
  Syrups, purées and milk stocked by weight use 1 ml ≈ 1 g.
* Garnish lines from the juiced fruit are merged into one recipe line; a garnish in another
  unit stays in the method text only.
* Economics are theoretical (current inventory cost × usage; reference price = median menu
  price of comparable active recipes). Atlas never sets a menu price on a draft.
* To-buy lines are saved as unlinked recipe lines (no item id); they block readiness in
  Recipes until linked, by design.
* Dessert and food ideas are pairing notes only; compose drafts drink specs.
* The snapshot cache is per Edge isolate (5 minutes); a new mapping review may take up to
  5 minutes to appear. The route rate limit is per isolate as well.
* Deterministic engine only: no model text is used to build ideas, quantities or names.
