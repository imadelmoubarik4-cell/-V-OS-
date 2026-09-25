// The Atlas AI tool registry: the only way the model touches Atlas.
//
// Entry: { name (dot form), fnName (underscore form, ^[a-zA-Z0-9_-]+$),
//          level 'read' | 'draft', roles, specialist, description
//          (model-facing), progress (user-facing label), parameters (strict
//          JSON Schema), sources (canonical backends, for the registry doc),
//          evidence (what the tool cites), execute(args, ctx) }
//
// There are no 'execute'-level tools: approved proposals run through
// actions.mjs executeProposal, which is not reachable from the model.

import { assertStrictSchema } from "./schema.mjs";
import { INVENTORY_TOOLS } from "./tools-inventory.mjs";
import { RECOGNITION_TOOLS } from "./tools-recognition.mjs";
import { RECIPE_TOOLS } from "./tools-recipes.mjs";
import { PURCHASING_TOOLS } from "./tools-purchasing.mjs";
import { REPORT_TOOLS } from "./tools-reports.mjs";
import { OPERATIONS_TOOLS, SHIFT_TOOLS } from "./tools-operations.mjs";
import { KNOWLEDGE_TOOLS, TEAM_TOOLS } from "./tools-people.mjs";
import { ADMIN_TOOLS } from "./tools-admin.mjs";

export const TOOL_LEVELS = Object.freeze(["read", "draft", "execute"]);
export const ROLE_ORDER = Object.freeze(["admin", "manager", "bartender", "viewer"]);

// Canonical source of truth per tool (documentation and audits).
const SOURCES = {
  "inventory.search": "inventory_items (managers) / inventory_catalog (staff) via user JWT; _shared/stock-provenance buildStockReport over atlas_stock_count_verified_balances() + movements",
  "inventory.get": "inventory_items / inventory_catalog, inventory_movements / inventory_movement_catalog (user JWT); buildStockReport; parsePackSize",
  "inventory.current_stock": "_shared/stock-provenance buildStockReport (verified count or owner confirmation + audited movements)",
  "inventory.below_par": "buildStockReport status below_par / out_of_stock (strict < positive par on verified stock)",
  "inventory.stale_counts": "buildStockReport quantity_status, verified_at, recount_due",
  "inventory.lookup_barcode": "atlas-inventory-scanner ?action=lookup (user JWT) + buildStockReport",
  "inventory.prepare_count": "inventory items (user JWT) + inventory.resolve_name + buildStockReport; executes via atlas-stock-counts start + save-line",
  "inventory.identify_from_image": "atlas_ai_media_get + atlas-ai-media storage (service) + vision extraction; _shared/recognition pipeline over atlas_recognition_resolve_codes / _candidates / _record (NOLOGIN recognition definer, no stock writes)",
  "inventory.resolve_name": "atlas_recognition_candidates (aliases, identity/name/match keys, packs) scored by _shared/recognition; falls back to the same scorer over inventory rows",
  "inventory.propose_alias": "inventory items + inventory.resolve_name; executes atlas_catalog_request_create alias (pending, source ai_proposal)",
  "inventory.propose_item": "atlas_recognition_find_duplicates (duplicate guard first); executes atlas_catalog_request_create new_item (pending, source ai_proposal)",
  "inventory.report_wrong_match": "inventory items; executes atlas_catalog_request_create wrong_match_report (pending, source ai_proposal)",
  "recipes.search": "recipes+recipe_ingredients (managers) / recipe_catalog (staff); _shared/atlas-domain recipeStatus over projectStock",
  "recipes.get": "recipes / recipe_catalog; atlas-domain recipeMetrics, recipeStatus, recipeBlockers",
  "recipes.can_make": "atlas-domain recipeAvailability / recipeStatus / recipeBlockers over projectStock",
  "recipes.cost": "atlas-domain recipeCost (recipeMetrics financials) over inventory_items cost_price",
  "recipes.best_margin": "atlas-domain recipeMetrics financials per active recipe",
  "purchasing.suggest": "atlas-domain orderSuggestions + orderGroups over projectStock; purchase_orders (user JWT) through the canonical open-order rule (drafts, pending, approved, placed, partly received)",
  "purchasing.get_supplier": "suppliers, inventory_items, purchase_orders (user JWT, manager RLS)",
  "purchasing.prepare_draft_po": "suppliers, inventory_items, purchase_orders (user JWT; canonical open-order rule); executes atlas_purchase_order_command_v2 create, or update on the supplier's existing Draft",
  "purchasing.order_status": "purchase_orders (user JWT) + venue business date",
  "purchasing.compare_delivery": "atlas_purchase_order_detail (user JWT) + inventory.resolve_name over the order lines; executes atlas_purchase_order_command_v2 receive_lines",
  "purchasing.cost_changes": "inventory_movements restock receipts with unit_cost (user JWT)",
  "reports.sales": "none — sales/POS not connected",
  "reports.margin": "atlas-domain recipeMetrics financials (theoretical)",
  "reports.inventory_value": "atlas-domain inventoryValue over projectStock",
  "reports.spend": "inventory_movements costed receipts + suppliers (user JWT)",
  "reports.waste": "inventory_movements / inventory_movement_catalog waste-type movements",
  "operations.status": "atlas_operations_today(p_local_date) + atlas_operations_daily_checklists(p_business_date) (service, all roles)",
  "operations.alerts": "stock-provenance applyStockTrustToWorkspace (buildStockReport + buildRecipeReport) + atlas_operations_today alerts + purchase_orders",
  "briefing.today": "atlas_settings_venue_clock + operations.status + operations.alerts + shifts.who_is_working (+ purchasing.suggest, purchase_orders, atlas_data_review_summary for managers)",
  "shifts.schedule": "atlas_shifts_snapshot(p_week_start, actor) (service; SQL shapes by role)",
  "shifts.who_is_working": "atlas_shifts_snapshot + atlas_settings_venue_clock business date",
  "shifts.prepare_draft": "atlas_shifts_snapshot; executes atlas-shifts ?action=save-shift",
  "team.get_profile": "atlas-team-profiles snapshot (user JWT), re-shaped by role",
  "team.prepare_message": "executes atlas-team-messages ?action=send (atlas_team_messages_send)",
  "knowledge.search": "atlas_knowledge_search(p_query, p_actor_id, p_actor_role, p_limit) (service; visibility in SQL)",
  "knowledge.get": "atlas_knowledge_article_detail(p_article_id, actor, p_prefer_draft=false)",
  "knowledge.prepare_draft": "atlas-knowledge snapshot categories; executes atlas-knowledge ?action=save-draft",
  "settings.read": "atlas_settings_venue_clock(p_actor_role) (+ atlas-settings snapshot for managers)",
  "settings.suggest_change": "none — link to Settings only",
  "decisions.history": "atlas_ai_memory_search / atlas_phase3_memory_search (service, managers)",
  "data_quality.review_list": "atlas_data_review_summary / atlas_data_review_rows (user JWT, managers)",
  "data_quality.par_suggestions": "atlas_par_level_evidence(p_item_ids, p_cover_days) (user JWT, managers)",
  "marketing.suggestions": "atlas_marketing_recommendations(p_local_date) (service, all roles)",
  "integrations.status": "atlas-integrations ?action=status (user JWT, managers)",
  "app.open": "none — returns a route",
};

// Proposal kind produced by each draft tool (documentation).
const PROPOSALS = {
  "inventory.prepare_count": "stock_count.draft",
  "inventory.propose_alias": "catalog.alias",
  "inventory.propose_item": "catalog.new_item",
  "inventory.report_wrong_match": "catalog.wrong_match",
  "purchasing.prepare_draft_po": "purchase_order.create or purchase_order.update_draft",
  "purchasing.compare_delivery": "purchase_order.receive",
  "shifts.prepare_draft": "shift.draft",
  "team.prepare_message": "team_message.send",
  "knowledge.prepare_draft": "knowledge.draft",
  "settings.suggest_change": "settings.suggestion (link only)",
  "data_quality.par_suggestions": "par_level.suggestion (link only)",
};

// Evidence each tool produces (documentation).
const EVIDENCE = {
  "inventory.search": "fact/missing stock per item",
  "inventory.get": "fact/missing stock, package size, par",
  "inventory.current_stock": "fact/missing stock per item; calculation verified share",
  "inventory.below_par": "calculation per low item; missing no-par and unknown-stock counts",
  "inventory.stale_counts": "calculation totals; fact per reason",
  "inventory.lookup_barcode": "fact match; fact/missing stock",
  "inventory.prepare_count": "fact counted (user-reported) and current stock",
  "inventory.identify_from_image": "interpretation label reading and each candidate's evidence sentence; fact exact code match (High); missing unreadable fields; estimate units visible in the photo (mode count, for a person to confirm)",
  "inventory.resolve_name": "fact exact name or code; interpretation name/alias match; missing no match",
  "inventory.propose_alias": "fact item; interpretation current resolution; missing not recognised yet",
  "inventory.propose_item": "interpretation possible existing matches with score and evidence; missing none found",
  "inventory.report_wrong_match": "fact matched item; interpretation reported right item",
  "recipes.search": "calculation/missing servings",
  "recipes.get": "fact stock/package/usage, calculation servings, missing blockers",
  "recipes.can_make": "fact stock, package size, recipe usage; calculation servings; missing blockers",
  "recipes.cost": "calculation ingredient cost, cost per serving, margin; missing costs/price",
  "recipes.best_margin": "calculation margins; missing realised margin",
  "purchasing.suggest": "calculation shortfall/cases; estimate cost; fact items already on an open order (with status); missing no-par/unknown",
  "purchasing.get_supplier": "fact/missing contact details, linked items, open orders",
  "purchasing.prepare_draft_po": "calculation line and order totals; fact existing draft for the supplier; interpretation supplier warnings and changed draft lines",
  "purchasing.order_status": "fact/missing expected delivery",
  "purchasing.compare_delivery": "fact/calculation per line; interpretation unexpected items; calculation price changes",
  "purchasing.cost_changes": "fact previous/latest receipt; calculation change %",
  "reports.sales": "error not_connected",
  "reports.margin": "calculation average/per recipe; missing realised margin",
  "reports.inventory_value": "calculation value or missing total; estimate lower bound",
  "reports.spend": "calculation spend; interpretation basis",
  "reports.waste": "fact waste entries; estimate cost (managers); missing unlogged waste",
  "operations.status": "fact per routine, temperature log; missing checklist setup",
  "operations.alerts": "fact per alert; missing coverage; calculation recipe readiness",
  "briefing.today": "fact/missing opening hours + the evidence of the composed tools",
  "shifts.schedule": "fact week status and day lines; interpretation not published",
  "shifts.who_is_working": "fact shifts, business date; interpretation not published",
  "shifts.prepare_draft": "fact week status; interpretation warnings",
  "team.get_profile": "fact/missing role, job title, training, contacts (managers)",
  "team.prepare_message": "interpretation draft text",
  "knowledge.search": "fact snippet per article (cited by article/version)",
  "knowledge.get": "fact article version",
  "knowledge.prepare_draft": "fact category",
  "settings.read": "fact time zone, business date, hours/offers; missing hours",
  "settings.suggest_change": "interpretation suggestion",
  "decisions.history": "fact per past decision",
  "data_quality.review_list": "fact per issue or record",
  "data_quality.par_suggestions": "calculation suggested par; missing ineligible",
  "marketing.suggestions": "fact per idea; interpretation seeded basis",
  "integrations.status": "fact/missing per provider; missing POS",
  "app.open": "none",
};

function fnNameFor(name) {
  return name.replace(/\./g, "_");
}

function freezeEntry(tool) {
  if (!tool?.name || typeof tool.execute !== "function") throw new Error("Invalid tool entry");
  if (!["read", "draft"].includes(tool.level)) throw new Error(`${tool.name}: the model may only have read or draft tools`);
  if (!Array.isArray(tool.roles) || !tool.roles.length || tool.roles.some((role) => !ROLE_ORDER.includes(role))) {
    throw new Error(`${tool.name}: invalid roles`);
  }
  assertStrictSchema(tool.parameters, `${tool.name}.parameters`);
  const fnName = fnNameFor(tool.name);
  if (!/^[a-zA-Z0-9_-]+$/.test(fnName) || fnName.length > 64) throw new Error(`${tool.name}: invalid function name`);
  return Object.freeze({
    name: tool.name,
    fnName,
    level: tool.level,
    roles: Object.freeze([...tool.roles]),
    specialist: tool.specialist,
    description: tool.description,
    progress: tool.progress,
    parameters: tool.parameters,
    source: SOURCES[tool.name] || null,
    proposalKind: PROPOSALS[tool.name] || null,
    evidence: EVIDENCE[tool.name] || null,
    execute: tool.execute,
  });
}

export const TOOL_REGISTRY = Object.freeze([
  ...INVENTORY_TOOLS,
  ...RECOGNITION_TOOLS,
  ...RECIPE_TOOLS,
  ...PURCHASING_TOOLS,
  ...REPORT_TOOLS,
  ...OPERATIONS_TOOLS,
  ...SHIFT_TOOLS,
  ...TEAM_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...ADMIN_TOOLS,
].map(freezeEntry));

const BY_NAME = new Map();
for (const entry of TOOL_REGISTRY) {
  if (BY_NAME.has(entry.name) || BY_NAME.has(entry.fnName)) throw new Error(`Duplicate tool ${entry.name}`);
  BY_NAME.set(entry.name, entry);
  BY_NAME.set(entry.fnName, entry);
}

// Look up by registry name ('inventory.current_stock') or function name
// ('inventory_current_stock').
export function getTool(nameOrFnName) {
  return BY_NAME.get(String(nameOrFnName || "")) || null;
}

// Tools a role may be offered. Never 'execute'.
export function toolsForRole(role, { specialist = null, levels = ["read", "draft"] } = {}) {
  const allowedLevels = (Array.isArray(levels) ? levels : ["read", "draft"]).filter((level) => level !== "execute");
  return TOOL_REGISTRY.filter((entry) => entry.roles.includes(role)
    && allowedLevels.includes(entry.level)
    && (!specialist || entry.specialist === specialist));
}

// Function definitions for the OpenAI Realtime session config / Responses
// API: { type: 'function', name, description, parameters, strict: true }.
export function functionDefinitions(role, options = {}) {
  return toolsForRole(role, options).map((entry) => ({
    type: "function",
    name: entry.fnName,
    description: entry.description,
    parameters: entry.parameters,
    strict: true,
  }));
}
