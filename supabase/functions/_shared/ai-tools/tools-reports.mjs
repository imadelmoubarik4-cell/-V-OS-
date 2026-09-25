// Reports & Finance tools. Sales are not connected, so there is no revenue,
// realised margin or labour-vs-sales figure anywhere in Atlas; the tools say
// so rather than inventing one. Unknown values are null, never zero.

import { inventoryValue, purchaseReceiptAmount } from "../atlas-domain.mjs";
import { S } from "./schema.mjs";
import { marginRows } from "./tools-recipes.mjs";
import {
  calculation, estimate, fact, formatIsk, formatNumber, interpretation, missing, ok, record, source, ToolError, truncate,
} from "./result.mjs";
import { clampLimit, isManagerActor, lower, numberOrNull, withinDays, nowMillis } from "./helpers.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const MANAGERS = ["admin", "manager"];
export const WASTE_TYPES = new Set(["waste", "variance", "spoilage", "breakage", "loss"]);

const sales = {
  name: "reports.sales",
  level: "read",
  roles: ALL,
  specialist: "reports",
  progress: "Checking sales data",
  description: "Sales, revenue, covers, best sellers, realised margin or labour cost vs sales. Sales/POS data is NOT connected to Atlas, so this always returns not_connected. Say so plainly; never estimate sales.",
  parameters: S.object({
    period: S.nullable(S.enum(["today", "yesterday", "week", "month"], "Period asked about")),
  }),
  async execute() {
    throw new ToolError("not_connected", "Sales data is not connected to Atlas (no POS integration), so revenue, covers, best sellers and realised margin are not available.");
  },
};

const margin = {
  name: "reports.margin",
  level: "read",
  roles: MANAGERS,
  specialist: "reports",
  progress: "Reviewing margins",
  description: "Manager only. Theoretical gross margin across recipes (menu price vs recipe cost from current inventory costs): average, highest and lowest, and how many recipes cannot be assessed. Not realised margin — sales are not connected.",
  parameters: S.object({
    query: S.nullable(S.string("Only recipes whose name or type contains these words", { maxLength: 100 })),
    menu_only: S.nullable(S.boolean("Only recipes shown on the menu")),
    limit: S.nullable(S.integer("How many highest/lowest to list (default 5)", { minimum: 1, maximum: 20 })),
  }),
  async execute(args, ctx) {
    const [recipes, items] = await Promise.all([ctx.services.recipes(), ctx.services.projectedItems()]);
    const words = lower(args.query).split(/\s+/).filter(Boolean);
    let rows = marginRows(recipes, items)
      .filter((row) => !words.length || words.every((word) => `${lower(row.name)} ${lower(row.type)}`.includes(word)));
    if (args.menu_only) rows = rows.filter((row) => row.show_on_menu);
    const known = rows.filter((row) => row.margin_known).sort((a, b) => b.margin_percent - a.margin_percent);
    const limit = clampLimit(args.limit, 5, 20);
    const average = known.length ? known.reduce((sum, row) => sum + row.margin_percent, 0) / known.length : null;
    const unknownCount = rows.length - known.length;
    return ok({
      summary: known.length
        ? `Average theoretical margin ${formatNumber(average, 1)}% over ${known.length} recipes; highest ${known[0].name} (${formatNumber(known[0].margin_percent, 1)}%), lowest ${known[known.length - 1].name} (${formatNumber(known[known.length - 1].margin_percent, 1)}%). ${unknownCount} recipes cannot be assessed. Realised margin needs sales, which are not connected.`
        : `No recipe has both a complete cost and a menu price, so margin cannot be assessed (${rows.length} recipes checked).`,
      data: {
        average_margin_percent: average,
        assessed: known.length,
        not_assessed: unknownCount,
        highest: known.slice(0, limit),
        lowest: known.slice(-limit).reverse(),
        basis: "theoretical",
      },
      evidence: [
        ...(average !== null ? [calculation("Average theoretical margin", `${formatNumber(average, 1)}% (${known.length} recipes)`, source("report", "recipes", "Recipe report"))] : []),
        ...known.slice(0, limit).map((row) => calculation(`${row.name} margin`, `${formatNumber(row.margin_percent, 1)}%`, source("recipe", row.id, row.name))),
        missing("Realised margin", "sales / POS data is not connected", source("integration", null, "Integrations")),
      ],
      records: known.slice(0, limit).map((row) => record("recipe", row.id, row.name)),
      unknown: unknownCount ? { count: unknownCount, reason: "Missing ingredient cost or menu price" } : null,
    });
  },
};

const inventoryValueTool = {
  name: "reports.inventory_value",
  level: "read",
  roles: MANAGERS,
  specialist: "reports",
  progress: "Valuing the stock",
  description: "Manager only. Stock value = verified quantity × inventory cost. The total is unknown (null, not zero) when any active item lacks a current verified count or a cost; the value of items that do have both is given as a lower bound with the counts of excluded items.",
  parameters: S.object({ category: S.nullable(S.string("Exact inventory category", { maxLength: 80 })) }),
  async execute(args, ctx) {
    const projected = await ctx.services.projectedItems();
    const scoped = projected.filter((item) => !args.category || lower(item.category) === lower(args.category));
    const result = inventoryValue(scoped);
    const src = source("report", "inventory", "Inventory report");
    const evidence = [];
    if (result.value !== null) evidence.push(calculation("Stock value", formatIsk(result.value), src));
    else evidence.push(missing("Total stock value", `unknown — ${result.unknown_items} items have no current count and ${result.missing_cost_items} have no cost`, src));
    if (result.known_value !== null && result.value === null) {
      evidence.push(estimate("Value of verified, costed items (lower bound)", formatIsk(result.known_value), src));
    }
    evidence.push(fact("Active items", String(result.active_items), src));
    return ok({
      summary: result.value !== null
        ? `Stock value ${formatIsk(result.value)}${args.category ? ` for ${args.category}` : ""}.`
        : `Total stock value is unknown: ${result.unknown_items} of ${result.active_items} items have no current verified count and ${result.missing_cost_items} have no cost.${result.known_value !== null ? ` Items that are counted and costed are worth at least ${formatIsk(result.known_value)}.` : ""}`,
      data: { ...result, category: args.category ?? null, rule: "Verified quantity × inventory cost; unknown when any item lacks a count or cost." },
      evidence,
      records: [],
      unknown: result.value === null ? { count: Math.max(result.unknown_items, result.missing_cost_items), reason: "Items without a current verified count or a cost", breakdown: { unknown_stock: result.unknown_items, missing_cost: result.missing_cost_items } } : null,
    });
  },
};

const spend = {
  name: "reports.spend",
  level: "read",
  roles: MANAGERS,
  specialist: "reports",
  progress: "Adding up purchasing spend",
  description: "Manager only. Purchasing spend over the last N days (default 30) from costed stock receipts recorded in Atlas, by supplier and top items. These are receipts, not supplier invoices; receipts without a cost are counted as unknown.",
  parameters: S.object({ days: S.nullable(S.integer("Period length in days (default 30)", { minimum: 1, maximum: 366 })) }),
  async execute(args, ctx) {
    const days = args.days ?? 30;
    const nowMs = nowMillis(ctx);
    const [movements, suppliers] = await Promise.all([ctx.services.movements(), ctx.services.suppliers()]);
    const names = new Map(suppliers.map((supplier) => [String(supplier.id), supplier.name]));
    // The canonical purchase receipt (atlas-domain purchaseReceiptAmount, the
    // same rule as Reports and the SQL snapshot): positive restock/receipt
    // movements; waste and adjustments are never spend.
    const receipts = movements.filter((movement) => purchaseReceiptAmount(movement) !== undefined
      && withinDays(movement.created_at, days, nowMs));
    let total = 0;
    let uncosted = 0;
    const bySupplier = new Map();
    const byItem = new Map();
    for (const movement of receipts) {
      const amount = purchaseReceiptAmount(movement);
      if (amount === null) {
        uncosted += 1;
        continue;
      }
      total += amount;
      const supplier = names.get(String(movement.supplier_id)) || "Supplier not recorded";
      bySupplier.set(supplier, (bySupplier.get(supplier) || 0) + amount);
      const itemKey = String(movement.item_id);
      const entry = byItem.get(itemKey) || { item_id: movement.item_id, name: movement.item_name || "Item", amount: 0 };
      entry.amount += amount;
      byItem.set(itemKey, entry);
    }
    const suppliersList = [...bySupplier].map(([supplier, amount]) => ({ supplier, amount })).sort((a, b) => b.amount - a.amount);
    const items = [...byItem.values()].sort((a, b) => b.amount - a.amount).slice(0, 10);
    return ok({
      summary: `${formatIsk(total)} of costed stock receipts in the last ${days} days across ${suppliersList.length} supplier(s)${uncosted ? `; ${uncosted} receipts have no cost and are not included` : ""}.`,
      data: { days, total, receipts: receipts.length, uncosted_receipts: uncosted, by_supplier: suppliersList, top_items: items, basis: "Costed stock receipts in Atlas (not supplier invoices). Waste and adjustments are not spend (see reports.waste)." },
      evidence: [
        calculation("Purchasing spend", `${formatIsk(total)} from ${receipts.length - uncosted} costed receipts`, source("report", "purchasing", "Purchasing report")),
        ...suppliersList.slice(0, 5).map((row) => calculation(`Spend with ${row.supplier}`, formatIsk(row.amount), source("report", "purchasing", "Purchasing report"))),
        interpretation("Basis", "Receipts recorded in Atlas; invoices are not connected", null),
      ],
      records: items.map((row) => record("inventory_item", row.item_id, row.name)),
      unknown: uncosted ? { count: uncosted, reason: "Receipts without a cost" } : null,
    });
  },
};

const waste = {
  name: "reports.waste",
  level: "read",
  roles: ALL,
  specialist: "reports",
  progress: "Checking waste",
  description: "Waste recorded in Atlas over the last N days (default 30): explicit waste, spoilage, breakage, loss and variance movements by item. Only what was logged — unlogged waste is unknown. Cost of waste is shown to managers only and only where a cost exists.",
  parameters: S.object({ days: S.nullable(S.integer("Period length in days (default 30)", { minimum: 1, maximum: 366 })) }),
  async execute(args, ctx) {
    const days = args.days ?? 30;
    const nowMs = nowMillis(ctx);
    const manager = isManagerActor(ctx.actor);
    const [movements, items] = await Promise.all([ctx.services.movements(), ctx.services.inventory()]);
    const costs = new Map(items.map((item) => [String(item.id), numberOrNull(item.cost_price)]));
    const units = new Map(items.map((item) => [String(item.id), item.unit || "units"]));
    const rows = movements.filter((movement) => WASTE_TYPES.has(lower(movement.movement_type)) && withinDays(movement.created_at, days, nowMs));
    const byItem = new Map();
    let costedValue = 0;
    let uncosted = 0;
    for (const movement of rows) {
      const quantity = Math.abs(numberOrNull(movement.quantity_change) ?? 0);
      const key = String(movement.item_id);
      const entry = byItem.get(key) || { item_id: movement.item_id, name: movement.item_name || "Item", unit: units.get(key) || "units", quantity: 0, events: 0, types: new Set() };
      entry.quantity += quantity;
      entry.events += 1;
      entry.types.add(lower(movement.movement_type));
      byItem.set(key, entry);
      if (manager) {
        const unitCost = numberOrNull(movement.unit_cost) ?? costs.get(key) ?? null;
        if (unitCost && unitCost > 0) costedValue += unitCost * quantity;
        else uncosted += 1;
      }
    }
    const list = [...byItem.values()].map((entry) => ({ ...entry, types: [...entry.types] })).sort((a, b) => b.events - a.events || b.quantity - a.quantity);
    const page = truncate(list, 15);
    return ok({
      summary: rows.length
        ? `${rows.length} waste/variance entries for ${list.length} items in the last ${days} days${manager ? `; logged cost about ${formatIsk(costedValue)}${uncosted ? ` (${uncosted} entries without cost)` : ""}` : ""}.`
        : `No waste was logged in the last ${days} days. Unlogged waste is not known to Atlas.`,
      data: { days, entries: rows.length, items: page.rows, truncated: page.truncated, ...(manager ? { estimated_cost: costedValue, uncosted_entries: uncosted } : {}) },
      evidence: [
        fact("Waste entries logged", `${rows.length} in ${days} days`, source("waste", null, "Waste log")),
        ...page.rows.slice(0, 10).map((row) => fact(`${row.name} wasted`, `${formatNumber(row.quantity)} ${row.unit} (${row.events} entries)`, source("inventory_item", row.item_id, row.name))),
        ...(manager && costedValue > 0 ? [estimate("Cost of logged waste", formatIsk(costedValue), source("waste", null, "Waste log"))] : []),
        missing("Unlogged waste", "not recorded, so not included", null),
      ],
      records: page.rows.map((row) => record("inventory_item", row.item_id, row.name)),
      unknown: manager && uncosted ? { count: uncosted, reason: "Waste entries without a cost" } : null,
    });
  },
};

export const REPORT_TOOLS = [sales, margin, inventoryValueTool, spend, waste];
