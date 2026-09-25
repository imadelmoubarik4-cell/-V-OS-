// Recipe tools. Readiness, blockers and cost come only from the canonical
// _shared/atlas-domain recipe rules over projected (verified) stock.

import { REFERENCE_COST_REASON, recipeBlockers, recipeMetrics, recipeStatus } from "../atlas-domain.mjs";
import { parsePackSize } from "../stock-provenance.mjs";
import { S } from "./schema.mjs";
import {
  calculation, fact, formatIsk, formatNumber, interpretation, missing, ok, quantityLabel, record, source, ToolError, truncate,
} from "./result.mjs";
import { clampLimit, lower, matchByName, numberOrNull, text } from "./helpers.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const MANAGERS = ["admin", "manager"];
const STATUS_KEYS = ["ready", "attention", "unavailable", "incomplete", "draft"];

const recipeSelector = {
  recipe_id: S.nullable(S.uuid("Recipe id if known")),
  recipe_query: S.nullable(S.string("Recipe name as the user said it", { maxLength: 120 })),
};

async function loadRecipes(ctx) {
  const [recipes, items] = await Promise.all([ctx.services.recipes(), ctx.services.projectedItems()]);
  return { recipes, items };
}

// Returns { recipe } or { clarification: ToolResult }.
function resolveRecipe(recipes, args) {
  if (args.recipe_id) {
    const recipe = recipes.find((candidate) => String(candidate.id) === args.recipe_id);
    if (!recipe) throw new ToolError("not_found", "That recipe was not found.");
    return { recipe };
  }
  if (!args.recipe_query) throw new ToolError("invalid_arguments", "Give recipe_id or recipe_query.");
  const match = matchByName(recipes, args.recipe_query);
  if (match.status === "unique") return { recipe: match.match };
  if (match.status === "none") throw new ToolError("not_found", `No recipe matches "${args.recipe_query}".`);
  return {
    clarification: ok({
      summary: `"${args.recipe_query}" matches ${match.candidates.length} recipes: ${match.candidates.map((recipe) => recipe.name).join(", ")}. Ask which one.`,
      data: { needs_clarification: [{ query: args.recipe_query, status: "ambiguous", candidates: match.candidates.map((recipe) => ({ id: recipe.id, name: recipe.name })) }] },
      evidence: [interpretation("Ambiguous recipe name", match.candidates.map((recipe) => recipe.name).join(" / "), null)],
      records: match.candidates.map((recipe) => record("recipe", recipe.id, recipe.name)),
    }),
  };
}

const recipeSource = (recipe) => source("recipe", recipe.id, recipe.name);

function servingsFrom(row, recipe) {
  const yieldQuantity = Math.max(0.0001, Number(recipe.yield_quantity) || 1);
  return Number.isFinite(row.batches) ? Math.max(0, Math.floor(row.batches * yieldQuantity)) : null;
}

// Evidence for each ingredient line: stock, package size, usage, servings.
function ingredientEvidence(recipe, rows) {
  const evidence = [];
  for (const row of rows) {
    const ingredientName = row.item?.name || row.ingredient?.item_name || "An ingredient";
    const usage = `${formatNumber(Number(row.ingredient?.quantity) || 0)} ${row.ingredient?.unit || ""}`.trim();
    if (!row.item) {
      evidence.push(missing(`${ingredientName} in ${recipe.name}`, "not linked to an inventory item", recipeSource(recipe)));
      continue;
    }
    const itemSrc = source("inventory_item", row.item.id, row.item.name);
    if (row.reference) {
      evidence.push(interpretation(`${ingredientName}`, "recipe reference, not stocked (ignored for availability)", itemSrc));
      continue;
    }
    evidence.push(row.item.freshness_state === "current"
      ? fact(`Stock of ${row.item.name}`, quantityLabel(row.item.verified_quantity, row.item.unit), itemSrc)
      : missing(`Stock of ${row.item.name}`, "unknown — no current verified count", itemSrc));
    const pack = parsePackSize(row.item);
    evidence.push(pack
      ? fact(`Package size of ${row.item.name}`, `${formatNumber(pack.quantity)} ${pack.unit} per ${row.item.unit || "unit"}`, itemSrc)
      : missing(`Package size of ${row.item.name}`, "not set or not readable", itemSrc));
    evidence.push(fact(`${recipe.name} uses`, `${usage} of ${row.item.name} per ${formatNumber(Number(recipe.yield_quantity) || 1)} serving(s)`, recipeSource(recipe)));
    const servings = servingsFrom(row, recipe);
    if (servings !== null) {
      const perBatch = row.batches > 0 ? Number(row.item.verified_quantity) / row.batches : null;
      const batchLabel = (Number(recipe.yield_quantity) || 1) === 1 ? "per serving" : "per recipe batch";
      evidence.push(calculation(`Servings from ${row.item.name}`, perBatch === null
        ? `${servings} (no verified stock left)`
        : `${servings} (${quantityLabel(row.item.verified_quantity, row.item.unit)} ÷ ${formatNumber(perBatch, 4)} ${row.item.unit || "units"} ${batchLabel})`, itemSrc));
    } else if (row.reason) {
      evidence.push(missing(`Servings from ${row.item.name}`, row.reason, itemSrc));
    }
  }
  return evidence;
}

function statusView(recipe, items) {
  const status = recipeStatus(recipe, items);
  return {
    id: recipe.id,
    name: recipe.name,
    type: recipe.type ?? null,
    status: status.key,
    status_label: status.label,
    servings_available: status.availability.servings,
    limiting_ingredient: status.availability.limiting?.item?.name ?? null,
    unknown_ingredients: status.availability.unknown,
    missing_links: status.availability.missing,
    show_on_menu: recipe.show_on_menu === true,
    menu_price: numberOrNull(recipe.menu_price),
  };
}

const search = {
  name: "recipes.search",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Looking through recipes",
  description: "Find recipes by name or type and/or filter by readiness (ready, attention = low availability, unavailable, incomplete = setup or stock evidence missing, draft = inactive). Returns readiness from current verified stock and the servings available when they can be calculated.",
  parameters: S.object({
    query: S.nullable(S.string("Words in the recipe name or type", { maxLength: 100 })),
    status: S.nullable(S.enum(STATUS_KEYS, "Readiness filter")),
    limit: S.nullable(S.integer("Maximum recipes (default 15)", { minimum: 1, maximum: 50 })),
  }),
  async execute(args, ctx) {
    const { recipes, items } = await loadRecipes(ctx);
    const words = lower(args.query).split(/\s+/).filter(Boolean);
    const views = recipes
      .filter((recipe) => !words.length || words.every((word) => `${lower(recipe.name)} ${lower(recipe.type)}`.includes(word)))
      .map((recipe) => statusView(recipe, items))
      .filter((view) => !args.status || view.status === args.status)
      .sort((a, b) => text(a.name).localeCompare(text(b.name)));
    const page = truncate(views, clampLimit(args.limit, 15, 50));
    const counts = {};
    for (const view of views) counts[view.status] = (counts[view.status] || 0) + 1;
    return ok({
      summary: `${views.length} ${views.length === 1 ? "recipe" : "recipes"} found${Object.keys(counts).length ? ` (${Object.entries(counts).map(([key, count]) => `${count} ${key}`).join(", ")})` : ""}.`,
      data: { recipes: page.rows, total: page.total, truncated: page.truncated, counts },
      evidence: page.rows.map((view) => view.servings_available !== null
        ? calculation(`${view.name} servings available`, `${view.servings_available}${view.limiting_ingredient ? ` (limited by ${view.limiting_ingredient})` : ""}`, source("recipe", view.id, view.name))
        : missing(`${view.name} servings available`, view.status === "draft" ? "recipe is inactive" : view.status === "unavailable" ? "0" : "unknown — ingredient stock or links missing", source("recipe", view.id, view.name))),
      records: page.rows.map((view) => record("recipe", view.id, view.name)),
      unknown: views.filter((view) => view.servings_available === null && view.status !== "unavailable").length
        ? { count: views.filter((view) => view.servings_available === null && view.status !== "unavailable").length, reason: "Servings cannot be calculated (unknown stock, unlinked or unmeasurable ingredients)" }
        : null,
    });
  },
};

const get = {
  name: "recipes.get",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Opening the recipe",
  description: "One recipe with its ingredients, method, yield, readiness and the ingredients blocking an availability calculation. Cost is not included (use recipes.cost, managers only).",
  parameters: S.object({ ...recipeSelector }),
  async execute(args, ctx) {
    const { recipes, items } = await loadRecipes(ctx);
    const resolved = resolveRecipe(recipes, args);
    if (resolved.clarification) return resolved.clarification;
    const recipe = resolved.recipe;
    const metrics = recipeMetrics(recipe, items);
    const blockers = recipeBlockers(recipe, items);
    const view = statusView(recipe, items);
    return ok({
      summary: `${recipe.name}: ${view.status_label}${view.servings_available !== null ? `, ${view.servings_available} servings possible` : ""}${blockers.length ? `; ${blockers.length} ingredient(s) block the calculation` : ""}.`,
      data: {
        recipe: {
          ...view,
          method: recipe.method ?? null,
          yield_quantity: numberOrNull(recipe.yield_quantity),
          yield_unit: recipe.yield_unit ?? null,
          ingredients: metrics.rows.map((row) => ({
            item_id: row.item?.id ?? row.ingredient?.item_id ?? null,
            name: row.item?.name || row.ingredient?.item_name || null,
            quantity: numberOrNull(row.ingredient?.quantity),
            unit: row.ingredient?.unit ?? null,
            linked: Boolean(row.item),
            reference: row.reference === true,
            stock_known: row.item?.freshness_state === "current",
            servings_from_ingredient: servingsFrom(row, recipe),
            issue: row.reason ?? null,
          })),
        },
        blockers,
      },
      evidence: ingredientEvidence(recipe, metrics.rows),
      records: [record("recipe", recipe.id, recipe.name), ...metrics.rows.filter((row) => row.item).map((row) => record("inventory_item", row.item.id, row.item.name))],
      unknown: blockers.length ? { count: blockers.length, reason: "Ingredients without a usable link, unit or verified count" } : null,
    });
  },
};

const canMake = {
  name: "recipes.can_make",
  level: "read",
  roles: ALL,
  specialist: "recipes",
  progress: "Checking whether we can make it",
  description: "Can we make N servings of a recipe? Answers yes, no or unknown from current verified stock using the canonical recipe rules, with the limiting ingredient and the evidence (stock, package size, recipe usage, servings per ingredient). Unknown when any stocked ingredient is unlinked, has an incompatible unit or has no current verified count — never guess.",
  parameters: S.object({
    ...recipeSelector,
    servings: S.nullable(S.integer("Servings wanted; null asks how many are possible", { minimum: 1, maximum: 10000 })),
  }),
  async execute(args, ctx) {
    const { recipes, items } = await loadRecipes(ctx);
    const resolved = resolveRecipe(recipes, args);
    if (resolved.clarification) return resolved.clarification;
    const recipe = resolved.recipe;
    const status = recipeStatus(recipe, items);
    const availability = status.availability;
    const metrics = recipeMetrics(recipe, items);
    const blockers = recipeBlockers(recipe, items);
    const possible = availability.servings;
    const limiting = availability.limiting?.item?.name ?? null;
    let answer;
    if (recipe.active === false) answer = "unknown";
    else if (availability.status === "unavailable") answer = "no";
    else if (possible === null) answer = "unknown";
    else if (args.servings === null) answer = possible > 0 ? "yes" : "no";
    else answer = possible >= args.servings ? "yes" : "no";

    const evidence = ingredientEvidence(recipe, metrics.rows);
    if (possible !== null) evidence.push(calculation(`Servings of ${recipe.name} possible`, `${possible}${limiting ? ` (limited by ${limiting})` : ""}`, recipeSource(recipe)));
    for (const blocker of blockers) evidence.push(missing(`${blocker.name}`, blocker.reason, recipeSource(recipe)));

    let summary;
    if (recipe.active === false) summary = `${recipe.name} is an inactive (draft) recipe.`;
    else if (answer === "unknown") summary = `Atlas cannot confirm ${recipe.name}${args.servings ? ` × ${args.servings}` : ""}: ${blockers.map((blocker) => `${blocker.name} (${blocker.reason})`).join("; ") || "ingredient stock cannot be calculated"}.`;
    else if (args.servings === null) summary = `${recipe.name}: ${possible} servings possible from verified stock${limiting ? `, limited by ${limiting}` : ""}.`;
    else summary = `${answer === "yes" ? "Yes" : "No"} — ${possible} servings of ${recipe.name} are possible from verified stock${limiting ? ` (limited by ${limiting})` : ""}; ${args.servings} requested.`;
    return ok({
      summary,
      data: {
        recipe_id: recipe.id,
        recipe_name: recipe.name,
        answer,
        servings_requested: args.servings,
        servings_possible: possible,
        limiting_ingredient: limiting,
        readiness: status.key,
        readiness_label: status.label,
        blockers,
        below_par_ingredients: availability.belowPar,
      },
      evidence,
      records: [record("recipe", recipe.id, recipe.name), ...metrics.rows.filter((row) => row.item).map((row) => record("inventory_item", row.item.id, row.item.name))],
      unknown: answer === "unknown" && blockers.length ? { count: blockers.length, reason: "Ingredients block the availability calculation" } : null,
    });
  },
};

const cost = {
  name: "recipes.cost",
  level: "read",
  roles: MANAGERS,
  specialist: "recipes",
  progress: "Working out recipe cost",
  description: "Manager only. Theoretical cost of one recipe from current inventory costs and package sizes: total batch cost, cost per serving, menu price, cost % and gross margin %. Lists ingredients with missing cost or incompatible units; the total is unknown (not partial) when any cost is missing.",
  parameters: S.object({ ...recipeSelector }),
  async execute(args, ctx) {
    const { recipes, items } = await loadRecipes(ctx);
    const resolved = resolveRecipe(recipes, args);
    if (resolved.clarification) return resolved.clarification;
    const recipe = resolved.recipe;
    const metrics = recipeMetrics(recipe, items);
    const financials = metrics.financials;
    const lines = metrics.rows.map((row) => ({
      name: row.item?.name || row.ingredient?.item_name || "An ingredient",
      item_id: row.item?.id ?? null,
      quantity: numberOrNull(row.ingredient?.quantity),
      unit: row.ingredient?.unit ?? null,
      cost: Number.isFinite(row.cost) ? row.cost : null,
      reference: row.reference === true,
      issue: Number.isFinite(row.cost) ? null : (row.item ? row.reason || "Missing inventory cost" : "Not linked to an inventory item"),
    }));
    const menuPrice = numberOrNull(recipe.menu_price);
    const complete = financials.incomplete === 0 && lines.length > 0;
    // A reference ingredient (Ice, Water) costs 0 (canonical REFERENCE_COST_REASON).
    const evidence = lines.map((line) => line.reference
      ? fact(`Cost of ${line.name}`, `${formatIsk(0)} (${REFERENCE_COST_REASON})`, line.item_id ? source("inventory_item", line.item_id, line.name) : recipeSource(recipe))
      : line.cost !== null
      ? calculation(`Cost of ${line.name}`, `${formatNumber(line.quantity ?? 0)} ${line.unit || ""} = ${formatIsk(line.cost)}`, line.item_id ? source("inventory_item", line.item_id, line.name) : recipeSource(recipe))
      : missing(`Cost of ${line.name}`, line.issue, line.item_id ? source("inventory_item", line.item_id, line.name) : recipeSource(recipe)));
    evidence.push(menuPrice !== null ? fact("Menu price", formatIsk(menuPrice), recipeSource(recipe)) : missing("Menu price", "not set", recipeSource(recipe)));
    if (complete) evidence.push(calculation("Cost per serving", formatIsk(financials.perServing), recipeSource(recipe)));
    if (complete && Number.isFinite(financials.margin)) evidence.push(calculation("Theoretical gross margin", `${formatNumber(financials.margin, 1)}%`, recipeSource(recipe)));
    return ok({
      summary: complete
        ? `${recipe.name} costs ${formatIsk(financials.perServing)} per serving${Number.isFinite(financials.margin) ? `, theoretical margin ${formatNumber(financials.margin, 1)}% at ${formatIsk(menuPrice)}` : ""}.`
        : `${recipe.name} cost is unknown: ${financials.incomplete} of ${lines.length} ingredients have no usable cost.`,
      data: {
        recipe_id: recipe.id,
        recipe_name: recipe.name,
        cost_total: complete ? financials.total : null,
        cost_per_serving: complete ? financials.perServing : null,
        menu_price: menuPrice,
        cost_percent: complete && Number.isFinite(financials.costPercent) ? financials.costPercent : null,
        margin_percent: complete && Number.isFinite(financials.margin) ? financials.margin : null,
        gross_profit_per_serving: complete && Number.isFinite(financials.profit) ? financials.profit : null,
        ingredients: lines,
        basis: "Theoretical: current inventory cost × recipe usage. Realised margin needs sales data, which is not connected.",
      },
      evidence,
      records: [record("recipe", recipe.id, recipe.name)],
      unknown: complete ? null : { count: financials.incomplete, reason: "Ingredients without a usable cost" },
    });
  },
};

export function marginRows(recipes, items) {
  return recipes.filter((recipe) => recipe.active !== false).map((recipe) => {
    const financials = recipeMetrics(recipe, items).financials;
    const known = financials.incomplete === 0 && Number.isFinite(financials.margin) && (recipe.recipe_ingredients || []).length > 0;
    return {
      id: recipe.id,
      name: recipe.name,
      type: recipe.type ?? null,
      show_on_menu: recipe.show_on_menu === true,
      menu_price: numberOrNull(recipe.menu_price),
      cost_per_serving: known ? financials.perServing : null,
      margin_percent: known ? financials.margin : null,
      gross_profit_per_serving: known ? financials.profit : null,
      margin_known: known,
      missing: known ? null : numberOrNull(recipe.menu_price) === null ? "menu price not set" : `${financials.incomplete} ingredient cost(s) missing`,
    };
  });
}

const bestMargin = {
  name: "recipes.best_margin",
  level: "read",
  roles: MANAGERS,
  specialist: "recipes",
  progress: "Comparing recipe margins",
  description: "Manager only. Recipes ranked by theoretical gross margin (menu price vs recipe cost from current inventory costs). This is not realised margin: sales are not connected. Also reports how many recipes cannot be ranked because a cost or price is missing.",
  parameters: S.object({
    limit: S.nullable(S.integer("How many to list (default 5)", { minimum: 1, maximum: 25 })),
    ready_only: S.nullable(S.boolean("Only recipes that are ready to serve from verified stock")),
    menu_only: S.nullable(S.boolean("Only recipes shown on the menu")),
  }),
  async execute(args, ctx) {
    const { recipes, items } = await loadRecipes(ctx);
    let rows = marginRows(recipes, items);
    if (args.menu_only) rows = rows.filter((row) => row.show_on_menu);
    if (args.ready_only) {
      const ready = new Set(recipes.filter((recipe) => recipeStatus(recipe, items).key === "ready").map((recipe) => String(recipe.id)));
      rows = rows.filter((row) => ready.has(String(row.id)));
    }
    const known = rows.filter((row) => row.margin_known).sort((a, b) => b.margin_percent - a.margin_percent);
    const unknownRows = rows.filter((row) => !row.margin_known);
    const page = truncate(known, clampLimit(args.limit, 5, 25));
    return ok({
      summary: known.length
        ? `Highest theoretical margin: ${known[0].name} at ${formatNumber(known[0].margin_percent, 1)}%. ${unknownRows.length} of ${rows.length} recipes cannot be ranked (missing cost or price). Realised margin needs sales, which are not connected.`
        : `No recipe has a complete cost and menu price, so margins cannot be ranked (${unknownRows.length} recipes checked).`,
      data: { ranked: page.rows, total_ranked: known.length, truncated: page.truncated, not_ranked: unknownRows.slice(0, 25).map((row) => ({ id: row.id, name: row.name, missing: row.missing })), basis: "theoretical" },
      evidence: [
        ...page.rows.map((row) => calculation(`${row.name} theoretical margin`, `${formatNumber(row.margin_percent, 1)}% (price ${formatIsk(row.menu_price)}, cost ${formatIsk(row.cost_per_serving)})`, source("recipe", row.id, row.name))),
        missing("Realised margin", "sales / POS data is not connected", source("integration", null, "Integrations")),
        interpretation("Basis", "Theoretical gross margin = (menu price − recipe cost per serving) ÷ menu price", null),
      ],
      records: page.rows.map((row) => record("recipe", row.id, row.name)),
      unknown: unknownRows.length ? { count: unknownRows.length, reason: "Missing ingredient cost or menu price" } : null,
    });
  },
};

export const RECIPE_TOOLS = [search, get, canMake, cost, bestMargin];
