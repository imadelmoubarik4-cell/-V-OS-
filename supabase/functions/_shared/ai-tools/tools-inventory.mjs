// Inventory tools. Stock truth comes only from the canonical
// buildStockReport / projectStock (verified count or owner confirmation +
// audited movements); raw imported quantities are never reported as stock.

import { parsePackSize } from "../stock-provenance.mjs";
import { S } from "./schema.mjs";
import { buildProposal, COUNT_UNITS } from "./actions.mjs";
import {
  calculation, fact, interpretation, missing, ok, quantityLabel, record, source, ToolError, truncate,
} from "./result.mjs";
import { clampLimit, isManagerActor, lower, newId, numberOrNull, text, venueDates, withinDays, nowMillis } from "./helpers.mjs";
import { resolveInventoryName } from "./tools-recognition.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const OPERATIONAL = ["admin", "manager", "bartender"];

export const STATUS_TEXT = {
  current: "verified by a current count",
  stale: "the last verified count has expired; needs a new count",
  historical: "only an old imported quantity exists; not counted since opening",
  unverified: "never verified by a count",
};

function words(value) {
  return lower(value).split(/\s+/).filter(Boolean);
}

function rowMatches(row, query) {
  const haystack = [row.name, row.category, row.brand, row.subcategory, row.sku, row.barcode, row.bin_location]
    .map((value) => lower(value)).join(" ");
  return words(query).every((word) => haystack.includes(word));
}

export function itemSource(row) {
  return source("inventory_item", row.id, row.name);
}

// Canonical stock evidence for one report row.
export function stockEvidence(row) {
  if (row.quantity_status === "current") {
    const via = row.quantity_source === "owner_confirmed" ? "owner-confirmed physical count" : "manager-verified count";
    const detail = row.movement_delta ? ` (${via} plus ${row.movement_delta > 0 ? "+" : ""}${row.movement_delta} in recorded movements since)` : ` (${via})`;
    return fact(`Current stock of ${row.name}`, `${quantityLabel(row.quantity, row.unit)}${detail}`, itemSource(row));
  }
  return missing(`Current stock of ${row.name}`, `unknown — ${STATUS_TEXT[row.quantity_status] || "not verified"}`, itemSource(row));
}

export function stockRowView(row, manager) {
  const view = {
    id: row.id,
    name: row.name,
    category: row.category ?? null,
    unit: row.unit ?? null,
    quantity: row.quantity_status === "current" ? row.quantity : null,
    quantity_status: row.quantity_status,
    stock_known: row.quantity_status === "current",
    verified_at: row.verified_at ?? null,
    recount_due: row.recount_due === true,
    par_level: numberOrNull(row.par_level),
    status: row.status,
    stock_status: row.stock_status ?? null,
    bin_location: row.bin_location ?? null,
  };
  if (manager) {
    view.cost_price = numberOrNull(row.cost_price);
    view.supplier = row.supplier ?? null;
    view.supplier_id = row.supplier_id ?? null;
    view.estimated_value = row.estimated_value ?? null;
  }
  return view;
}

function unknownStock(rows) {
  const unknown = rows.filter((row) => row.quantity_status !== "current");
  return unknown.length
    ? { count: unknown.length, reason: "No current verified count, so stock is unknown (not zero)" }
    : null;
}

async function report(ctx, filters = {}) {
  return ctx.services.stockReport(filters);
}

// ---------------------------------------------------------------------------

const search = {
  name: "inventory.search",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Looking up items",
  description: "Find inventory items by name, brand, category, SKU, barcode or storage location. Returns each item's id, unit, par level and whether its stock is verified. Stock is only a number when a current verified count exists; otherwise it is unknown (never zero). Use inventory.get or inventory.current_stock for detail.",
  parameters: S.object({
    query: S.string("Words to look for, e.g. 'tanqueray' or 'pinot grigio'", { maxLength: 100 }),
    category: S.nullable(S.string("Exact inventory category, e.g. 'Wine'", { maxLength: 80 })),
    include_inactive: S.nullable(S.boolean("Also return deactivated items (default false)")),
    limit: S.nullable(S.integer("Maximum items to return (default 10)", { minimum: 1, maximum: 25 })),
  }),
  async execute(args, ctx) {
    const manager = isManagerActor(ctx.actor);
    const stock = await report(ctx, args.category ? { category: args.category } : {});
    let rows = stock.rows.filter((row) => rowMatches(row, args.query)).map((row) => stockRowView(row, manager));
    if (args.include_inactive) {
      const inactive = (await ctx.services.inventory())
        .filter((item) => item.active === false && rowMatches(item, args.query)
          && (!args.category || lower(item.category) === lower(args.category)))
        .map((item) => ({ id: item.id, name: item.name, category: item.category ?? null, unit: item.unit ?? null, quantity: null, quantity_status: "inactive", stock_known: false, status: "inactive" }));
      rows = rows.concat(inactive);
    }
    const needle = lower(args.query);
    rows.sort((a, b) => Number(lower(b.name) === needle) - Number(lower(a.name) === needle)
      || Number(lower(b.name).startsWith(needle)) - Number(lower(a.name).startsWith(needle))
      || text(a.name).localeCompare(text(b.name)));
    const page = truncate(rows, clampLimit(args.limit, 10, 25));
    return ok({
      summary: page.total
        ? `${page.total} ${page.total === 1 ? "item matches" : "items match"} "${args.query}"${page.truncated ? ` (showing ${page.rows.length})` : ""}.`
        : `No inventory item matches "${args.query}".`,
      data: { items: page.rows, total: page.total, truncated: page.truncated },
      evidence: page.rows.map((row) => row.stock_known
        ? fact(`Current stock of ${row.name}`, quantityLabel(row.quantity, row.unit), source("inventory_item", row.id, row.name))
        : missing(`Current stock of ${row.name}`, row.quantity_status === "inactive" ? "item is deactivated" : `unknown — ${STATUS_TEXT[row.quantity_status]}`, source("inventory_item", row.id, row.name))),
      records: page.rows.map((row) => record("inventory_item", row.id, row.name)),
      unknown: unknownStock(page.rows.filter((row) => row.quantity_status !== "inactive")),
    });
  },
};

const get = {
  name: "inventory.get",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Opening the item",
  description: "Full detail for one inventory item by id: verified stock (or unknown with the reason), when it was counted, par level, package size, storage location and the latest stock movements. Cost and supplier are included for managers only.",
  parameters: S.object({ item_id: S.uuid("Inventory item id (from inventory.search)") }),
  async execute(args, ctx) {
    const manager = isManagerActor(ctx.actor);
    const [stock, items, movements] = await Promise.all([report(ctx), ctx.services.inventory(), ctx.services.movements()]);
    const item = items.find((candidate) => String(candidate.id) === args.item_id);
    if (!item) throw new ToolError("not_found", "That inventory item was not found.");
    const row = stock.evidence_rows.find((candidate) => String(candidate.id) === args.item_id);
    const pack = parsePackSize(item);
    const recent = movements.filter((movement) => String(movement.item_id) === args.item_id).slice(0, 5)
      .map((movement) => ({ id: movement.id, type: movement.movement_type, quantity_change: numberOrNull(movement.quantity_change), note: movement.note ?? null, created_at: movement.created_at }));
    const data = {
      item: row ? stockRowView(row, manager) : { id: item.id, name: item.name, category: item.category ?? null, unit: item.unit ?? null, quantity: null, quantity_status: "inactive", stock_known: false, status: "inactive" },
      active: item.active !== false,
      package_size: pack ? { quantity: pack.quantity, unit: pack.unit } : null,
      units_per_case: numberOrNull(item.units_per_case),
      sku: item.sku ?? null,
      barcode: item.barcode ?? null,
      recent_movements: recent,
    };
    const evidence = [];
    if (row) evidence.push(stockEvidence(row));
    else evidence.push(missing(`Current stock of ${item.name}`, "item is deactivated", source("inventory_item", item.id, item.name)));
    evidence.push(pack
      ? fact("Package size", `${pack.quantity} ${pack.unit}`, source("inventory_item", item.id, item.name))
      : missing("Package size", "not set or not readable", source("inventory_item", item.id, item.name)));
    evidence.push(numberOrNull(item.par_level) > 0
      ? fact("Par level", `${numberOrNull(item.par_level)} ${item.unit || "units"}`, source("inventory_item", item.id, item.name))
      : missing("Par level", "not set", source("inventory_item", item.id, item.name)));
    return ok({
      summary: row?.quantity_status === "current"
        ? `${item.name}: ${quantityLabel(row.quantity, row.unit)} verified.`
        : `${item.name}: stock unknown (${row ? STATUS_TEXT[row.quantity_status] : "item is deactivated"}).`,
      data,
      evidence,
      records: [record("inventory_item", item.id, item.name)],
      unknown: row && row.quantity_status !== "current" ? { count: 1, reason: STATUS_TEXT[row.quantity_status] } : null,
    });
  },
};

const currentStock = {
  name: "inventory.current_stock",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Checking stock",
  description: "Current reconciled stock for specific items (item_ids), items matching words (query), a category, or an overview when all are null. A quantity is given only when a current verified count exists; every other item is reported as unknown with the reason (stale, historical, never counted). Unknown is never zero.",
  parameters: S.object({
    item_ids: S.nullable(S.array(S.uuid(), "Specific inventory item ids", { minItems: 1, maxItems: 25 })),
    query: S.nullable(S.string("Words to match item names", { maxLength: 100 })),
    category: S.nullable(S.string("Exact inventory category", { maxLength: 80 })),
    limit: S.nullable(S.integer("Maximum items listed (default 15)", { minimum: 1, maximum: 50 })),
  }),
  async execute(args, ctx) {
    const manager = isManagerActor(ctx.actor);
    const stock = await report(ctx, args.category ? { category: args.category } : {});
    let rows = stock.rows;
    if (args.item_ids) {
      const wanted = new Set(args.item_ids);
      rows = stock.evidence_rows.filter((row) => wanted.has(String(row.id)));
    }
    if (args.query) rows = rows.filter((row) => rowMatches(row, args.query));
    const views = rows.map((row) => stockRowView(row, manager));
    const page = truncate(views, clampLimit(args.limit, 15, 50));
    const known = rows.filter((row) => row.quantity_status === "current").length;
    const scoped = Boolean(args.item_ids || args.query || args.category);
    const evidence = rows.slice(0, page.rows.length).map(stockEvidence);
    evidence.push(calculation("Items with verified stock", `${known} of ${rows.length}`, source("report", "inventory", "Inventory report")));
    return ok({
      summary: rows.length
        ? `${known} of ${rows.length} ${scoped ? "matching " : "active "}items have verified stock; ${rows.length - known} are unknown.`
        : "No matching active inventory items.",
      data: {
        items: page.rows,
        total: page.total,
        truncated: page.truncated,
        summary: scoped ? null : { active_items: stock.summary.active_items, current_items: stock.summary.current_items, stale_items: stock.summary.stale_items, historical_items: stock.summary.historical_items, unverified_items: stock.summary.unverified_items },
        rule: stock.formula,
      },
      evidence,
      records: page.rows.map((row) => record("inventory_item", row.id, row.name)),
      unknown: unknownStock(rows),
    });
  },
};

const belowParTool = {
  name: "inventory.below_par",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Checking what is running low",
  description: "Items whose current verified stock is strictly below their par level, plus items verified at zero. Always also reports how many items cannot be judged: items with no par level set (most items today) and items with a par but no current verified count. Never infer low stock for those.",
  parameters: S.object({
    category: S.nullable(S.string("Exact inventory category", { maxLength: 80 })),
    limit: S.nullable(S.integer("Maximum items listed (default 25)", { minimum: 1, maximum: 50 })),
  }),
  async execute(args, ctx) {
    const manager = isManagerActor(ctx.actor);
    const stock = await report(ctx, args.category ? { category: args.category } : {});
    const rows = stock.rows;
    // The canonical stock status (stock-provenance stockStatus) on every row:
    // out and below par are separate; unknown stock and counted stock without a
    // par cannot be judged low.
    const below = rows.filter((row) => row.stock_status === "below_par");
    const out = rows.filter((row) => row.stock_status === "out");
    const noPar = rows.filter((row) => (numberOrNull(row.par_level) ?? 0) <= 0).length;
    const parUnknownStock = rows.filter((row) => (numberOrNull(row.par_level) ?? 0) > 0 && row.stock_status === "unknown").length;
    const undeterminable = rows.filter((row) => row.stock_status === "unknown" || row.stock_status === "no_par").length;
    const limit = clampLimit(args.limit, 25, 50);
    const flagged = [...out, ...below];
    const page = truncate(flagged.map((row) => stockRowView(row, manager)), limit);
    const evidence = flagged.slice(0, limit).map((row) => row.stock_status === "out"
      ? fact(`${row.name} is out of stock`, `verified ${quantityLabel(row.quantity, row.unit)}`, itemSource(row))
      : calculation(`${row.name} is below par`, `${quantityLabel(row.quantity, row.unit)} verified < par ${numberOrNull(row.par_level)}`, itemSource(row)));
    evidence.push(missing("Items with no par level", `${noPar} of ${rows.length} active items — Atlas cannot say whether they are low`, source("par_levels", null, "Par levels")));
    if (parUnknownStock) evidence.push(missing("Items with a par but no current count", `${parUnknownStock} items`, source("stock_count", null, "Stock count")));
    return ok({
      summary: `${below.length} below par and ${out.length} out of stock from current verified counts (${below.length + out.length} need ordering). ${undeterminable} of ${rows.length} active items cannot be judged (no current count, or counted with no par level); ${noPar} have no par level and ${parUnknownStock} have a par but no current count.`,
      data: {
        below_par: page.rows.filter((row) => row.stock_status === "below_par"),
        out_of_stock: page.rows.filter((row) => row.stock_status === "out"),
        truncated: page.truncated,
        counts: {
          active_items: rows.length,
          current_items: rows.filter((row) => row.quantity_status === "current").length,
          below_par: below.length,
          out_of_stock: out.length,
          needs_ordering: below.length + out.length,
          missing_par: noPar,
          par_but_unknown_stock: parUnknownStock,
          undeterminable,
        },
        rule: "One stock status: unknown (no current verified count) > out (verified quantity at or below zero) > below par (strictly under a positive par) > no par > ok. Out and below par are counted separately; needs ordering = out + below par. Unknown stock is never low.",
      },
      evidence,
      records: page.rows.map((row) => record("inventory_item", row.id, row.name)),
      unknown: { count: undeterminable, reason: "No par level set or no current verified count", breakdown: { missing_par: noPar, par_but_unknown_stock: parUnknownStock } },
    });
  },
};

const staleCounts = {
  name: "inventory.stale_counts",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Checking which items need counting",
  description: "Items that have not been counted recently: never verified, only historical imports, expired counts, owner confirmations due for recount, and current counts older than `days` (default 7). Grouped by reason and category, useful for planning a stock count.",
  parameters: S.object({
    category: S.nullable(S.string("Exact inventory category", { maxLength: 80 })),
    days: S.nullable(S.integer("Counts older than this many days are listed (default 7)", { minimum: 1, maximum: 90 })),
    limit: S.nullable(S.integer("Maximum items listed (default 25)", { minimum: 1, maximum: 50 })),
  }),
  async execute(args, ctx) {
    const manager = isManagerActor(ctx.actor);
    const days = args.days ?? 7;
    const nowMs = nowMillis(ctx);
    const stock = await report(ctx, args.category ? { category: args.category } : {});
    const reasons = [];
    for (const row of stock.rows) {
      let reason = null;
      if (row.quantity_status !== "current") reason = row.quantity_status;
      else if (row.recount_due) reason = "recount_due";
      else if (!withinDays(row.verified_at, days, nowMs)) reason = "older_than_window";
      if (reason) reasons.push({ row, reason });
    }
    const byReason = {};
    const byCategory = {};
    for (const { row, reason } of reasons) {
      byReason[reason] = (byReason[reason] || 0) + 1;
      const category = text(row.category) || "Uncategorised";
      byCategory[category] = (byCategory[category] || 0) + 1;
    }
    const page = truncate(reasons.map(({ row, reason }) => ({ ...stockRowView(row, manager), reason })), clampLimit(args.limit, 25, 50));
    return ok({
      summary: `${reasons.length} of ${stock.rows.length} active items need counting (not counted in the last ${days} days or never verified).`,
      data: { items: page.rows, total: page.total, truncated: page.truncated, by_reason: byReason, by_category: byCategory, window_days: days },
      evidence: [
        calculation("Items needing a count", `${reasons.length} of ${stock.rows.length}`, source("stock_count", null, "Stock count")),
        ...Object.entries(byReason).map(([reason, count]) => fact(`Reason: ${reason.replace(/_/g, " ")}`, `${count} items`, source("report", "inventory", "Inventory report"))),
      ],
      records: page.rows.map((row) => record("inventory_item", row.id, row.name)),
      unknown: unknownStock(stock.rows),
    });
  },
};

const lookupBarcode = {
  name: "inventory.lookup_barcode",
  level: "read",
  roles: ALL,
  specialist: "inventory",
  progress: "Looking up the barcode",
  description: "Find the inventory item for a scanned barcode or SKU using the scanner's verified aliases and item codes. Returns the item and its verified stock, or says the code is unknown or matches several items.",
  parameters: S.object({ code: S.string("Barcode, EAN/UPC or SKU", { minLength: 3, maxLength: 64 }) }),
  async execute(args, ctx) {
    const response = await ctx.services.scannerLookup(args.code);
    const lookup = response?.lookup || {};
    if (!lookup.matched || !lookup.item?.id) {
      return ok({
        summary: lookup.stale_alias ? "This code was linked to an item that is no longer available." : "No inventory item is linked to this code.",
        data: { matched: false, code: args.code, ambiguous: Array.isArray(lookup.candidates) && lookup.candidates.length > 1 },
        evidence: [missing("Barcode match", `no verified item for ${args.code}`, source("inventory", null, "Inventory"))],
        records: [],
      });
    }
    const stock = await report(ctx);
    const row = stock.evidence_rows.find((candidate) => String(candidate.id) === String(lookup.item.id));
    const manager = isManagerActor(ctx.actor);
    return ok({
      summary: `${args.code} is ${lookup.item.name}${row ? `; stock ${row.quantity_status === "current" ? quantityLabel(row.quantity, row.unit) : "unknown"}` : ""}.`,
      data: { matched: true, match_source: lookup.match_source ?? null, item: row ? stockRowView(row, manager) : { id: lookup.item.id, name: lookup.item.name } },
      evidence: [
        fact("Barcode match", `${args.code} → ${lookup.item.name} (${lookup.match_source === "verified_alias" ? "verified scanner link" : "item code"})`, source("inventory_item", lookup.item.id, lookup.item.name)),
        ...(row ? [stockEvidence(row)] : []),
      ],
      records: [record("inventory_item", lookup.item.id, lookup.item.name)],
      unknown: row && row.quantity_status !== "current" ? { count: 1, reason: STATUS_TEXT[row.quantity_status] } : null,
    });
  },
};

const prepareCount = {
  name: "inventory.prepare_count",
  level: "draft",
  roles: OPERATIONAL,
  specialist: "inventory",
  progress: "Preparing a stock count",
  description: "Prepare (not save) a stock count from quantities the user reports, e.g. a voice note 'six Tanqueray and two Campari'. Each entry names an item (item_id when known, otherwise item_query) and the counted quantity and unit. If any name matches several items or none, nothing is prepared and the candidates are returned so you can ask the user. The result is a proposal the user must approve; approval starts a count session for normal verification and never adjusts stock directly.",
  parameters: S.object({
    entries: S.array(S.object({
      item_id: S.nullable(S.uuid("Inventory item id if known")),
      item_query: S.nullable(S.string("Item name as the user said it, e.g. 'Tanqueray'", { maxLength: 120 })),
      quantity: S.number("Counted quantity", { minimum: 0, maximum: 100000 }),
      unit: S.nullable(S.enum(COUNT_UNITS, "Unit counted; null means the item's own inventory unit")),
      note: S.nullable(S.string("Optional note for this line", { maxLength: 500 })),
    }), "Counted lines", { minItems: 1, maxItems: 30 }),
    title: S.nullable(S.string("Count title (default 'Atlas count <date>')", { maxLength: 120 })),
    note: S.nullable(S.string("Note for the count session", { maxLength: 1000 })),
  }),
  async execute(args, ctx) {
    const items = (await ctx.services.inventory()).filter((item) => item.active !== false);
    const resolved = [];
    const clarifications = [];
    for (const [index, entry] of args.entries.entries()) {
      let item = null;
      if (entry.item_id) {
        item = items.find((candidate) => String(candidate.id) === entry.item_id) || null;
        if (!item) clarifications.push({ entry: index, query: entry.item_id, status: "not_found", candidates: [] });
      } else if (entry.item_query) {
        // Canonical resolver: aliases, Icelandic/English spellings and pack
        // sizes ("Aperol 70cl" is Aperol), never a guess between items.
        const match = await resolveInventoryName(ctx, entry.item_query, { universe: items });
        if (match.status === "unique") item = items.find((candidate) => String(candidate.id) === String(match.match.item_id)) || null;
        if (!item) clarifications.push({ entry: index, query: entry.item_query, status: match.status === "none" ? "not_found" : "ambiguous", candidates: match.candidates.map((candidate) => ({ id: candidate.item_id, name: candidate.item?.name ?? null, unit: candidate.item?.unit ?? null })) });
      } else {
        throw new ToolError("invalid_arguments", `Entry ${index + 1} needs item_id or item_query.`);
      }
      if (item) resolved.push({ entry, item });
    }
    const duplicate = resolved.find((value, index) => resolved.findIndex((other) => other.item.id === value.item.id) !== index);
    if (duplicate) {
      clarifications.push({ entry: null, query: duplicate.item.name, status: "duplicate", candidates: [{ id: duplicate.item.id, name: duplicate.item.name, unit: duplicate.item.unit ?? null }] });
    }
    if (clarifications.length) {
      return ok({
        summary: `Atlas needs clarification before preparing the count: ${clarifications.map((entry) => `"${entry.query}" ${entry.status === "ambiguous" ? `matches ${entry.candidates.length} items` : entry.status === "duplicate" ? "is listed twice" : "matches no item"}`).join("; ")}.`,
        data: { needs_clarification: clarifications, resolved: resolved.map(({ entry, item }) => ({ item_id: item.id, item_name: item.name, quantity: entry.quantity, unit: entry.unit || "inventory" })) },
        evidence: clarifications.map((entry) => interpretation(`Could not resolve "${entry.query}"`, entry.status === "ambiguous" ? entry.candidates.map((candidate) => candidate.name).join(" / ") : entry.status, null)),
        records: clarifications.flatMap((entry) => entry.candidates.map((candidate) => record("inventory_item", candidate.id, candidate.name))),
      });
    }
    const stock = await report(ctx);
    const categories = [...new Set(resolved.map(({ item }) => text(item.category)).filter(Boolean))];
    const scope = categories.length === 1 && resolved.every(({ item }) => text(item.category)) ? { type: "category", value: categories[0] } : { type: "all", value: null };
    const date = (await venueDates(ctx, ctx.services)).businessDate;
    const command = {
      title: args.title || `Atlas count ${date}`,
      scope_type: scope.type,
      scope_value: scope.value,
      notes: args.note ?? "Prepared with Atlas AI from counted quantities reported by the user.",
      client_request_id: ctx.newId ? ctx.newId() : newId(),
      entries: resolved.map(({ entry, item }) => ({
        item_id: String(item.id),
        item_name: String(item.name),
        quantity: entry.quantity,
        unit: entry.unit || "inventory",
        note: entry.note ?? null,
      })),
    };
    const evidence = resolved.flatMap(({ entry, item }) => {
      const row = stock.evidence_rows.find((candidate) => String(candidate.id) === String(item.id));
      return [
        fact(`Counted ${item.name}`, `${entry.quantity} ${entry.unit && entry.unit !== "inventory" ? entry.unit : item.unit || "units"} (reported by you)`, source("inventory_item", item.id, item.name)),
        ...(row ? [stockEvidence(row)] : []),
      ];
    });
    const proposal = buildProposal("stock_count.draft", command, {
      title: `Stock count: ${resolved.map(({ item }) => item.name).slice(0, 3).join(", ")}${resolved.length > 3 ? "…" : ""}`,
      subjectKey: command.client_request_id,
      evidence: evidence.slice(0, 20),
    });
    return ok({
      summary: `Prepared a stock count with ${resolved.length} counted ${resolved.length === 1 ? "line" : "lines"}. Nothing is saved until you approve; stock changes only after manager verification.`,
      data: { entries: command.entries, scope },
      evidence,
      records: resolved.map(({ item }) => record("inventory_item", item.id, item.name)),
      proposal,
    });
  },
};

export const INVENTORY_TOOLS = [search, get, currentStock, belowParTool, staleCounts, lookupBarcode, prepareCount];
