// ToolResult helpers, evidence builders and Atlas app routes.
//
// ToolResult (every tool, success):
//   { ok: true, summary, data, evidence: Evidence[], records: RecordRef[],
//     proposal: Proposal | null, unknown: Unknown | null }
// Failure:
//   { ok: false, error: { code, message } }
//   code ∈ forbidden | not_found | invalid_arguments | not_connected |
//          unavailable | limit_exceeded | not_executable | conflict
// Evidence: { kind: fact|calculation|interpretation|estimate|missing,
//             label, value, source: { type, id, label, route } | null }
// RecordRef: { type, id, label, route }
// Unknown:  { count, reason, breakdown? }
import { formatKr } from "../atlas-domain.mjs";

export const EVIDENCE_KINDS = Object.freeze(["fact", "calculation", "interpretation", "estimate", "missing"]);
export const ERROR_CODES = Object.freeze([
  "forbidden", "not_found", "invalid_arguments", "not_connected", "unavailable",
  "limit_exceeded", "not_executable", "conflict",
]);

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolError";
    this.code = ERROR_CODES.includes(code) ? code : "unavailable";
  }
}

export function fail(code, message) {
  return { ok: false, error: { code: ERROR_CODES.includes(code) ? code : "unavailable", message: String(message || "") } };
}

export function ok({ summary, data = {}, evidence = [], records = [], proposal = null, unknown = null }) {
  return {
    ok: true,
    summary: String(summary || ""),
    data: data ?? {},
    evidence: evidence.filter(Boolean),
    records: dedupeRecords(records.filter(Boolean)),
    proposal: proposal ?? null,
    unknown: unknown && Number(unknown.count) > 0 ? unknown : null,
  };
}

function dedupeRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = `${record.type}:${record.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Hash routes per the redesign route table (docs/design/Atlas_Experience_Redesign.md §3.4). The shell
// selects the view from the part before `?`; every query parameter used here is
// read by its page (tests/node/ai-route-parity-s89.test.js):
//   #data/pars?item=         Data › Par levels focuses the item
//   #data/issues?issue=      Data › Issues opens that issue code
//   #inventory/movements?movement=  Inventory › Movements shows that record
//   #shifts?week=            Shifts opens that week
//   #ai/decisions?recommendation=   Atlas AI › Decisions opens that decision
//   #marketing?recommendation=      Marketing shows that suggestion
//   #settings/integrations?provider= Settings › Integrations shows that provider
const ROUTES = {
  inventory_item: (id) => `#inventory/item/${enc(id)}`,
  inventory: () => "#inventory",
  stock_count: (id) => (id ? `#inventory/counts/${enc(id)}` : "#inventory/counts"),
  par_levels: (id) => (id ? `#data/pars?item=${enc(id)}` : "#data/pars"),
  data_review: (id) => (id ? `#data/issues?issue=${enc(id)}` : "#data/issues"),
  movement: (id) => `#inventory/movements?movement=${enc(id)}`,
  waste: () => "#inventory/waste",
  recipe: (id) => `#recipes/${enc(id)}`,
  recipes: () => "#recipes",
  supplier: (id) => `#purchasing/suppliers/${enc(id)}`,
  purchase_order: (id) => (id ? `#purchasing/order/${enc(id)}` : "#purchasing"),
  report: (id) => `#reports/${enc(id || "overview")}`,
  routine: (id) => `#operations/${enc(id)}`,
  operations: () => "#operations",
  shift_week: (id) => `#shifts?week=${enc(id)}`,
  // No page opens a single shift by id; a shift link opens Shifts (use
  // shift_week with the week start to open the right week).
  shift: () => "#shifts",
  profile: (id) => `#team/${enc(id)}`,
  team_channel: (id) => `#messages/${enc(id)}`,
  knowledge_article: (id) => `#knowledge/${enc(id)}`,
  knowledge: () => "#knowledge",
  settings: (id) => `#settings/${enc(id || "venue")}`,
  brain_recommendation: (id) => `#ai/decisions?recommendation=${enc(id)}`,
  brain_memory: () => "#ai/decisions",
  marketing_recommendation: (id) => `#marketing?recommendation=${enc(id)}`,
  marketing: () => "#marketing",
  integration: (id) => (id ? `#settings/integrations?provider=${enc(id)}` : "#settings/integrations"),
  venue_clock: () => "#settings/hours",
  home: () => "#home",
};

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

// Screen roots used when a route is asked for without a record id.
const ROOTS = {
  inventory_item: "#inventory", movement: "#inventory/movements", recipe: "#recipes", supplier: "#purchasing/suppliers",
  report: "#reports/overview", routine: "#operations", shift_week: "#shifts", shift: "#shifts", profile: "#team",
  team_channel: "#messages", knowledge_article: "#knowledge", brain_recommendation: "#ai/decisions",
  marketing_recommendation: "#marketing",
};

export function routeFor(type, id = null) {
  const builder = ROUTES[type];
  if (!builder) return null;
  if ((id === null || id === undefined || id === "") && ROOTS[type]) return ROOTS[type];
  return builder(id);
}

export function source(type, id, label) {
  return { type, id: id == null ? null : String(id), label: label == null ? null : String(label), route: routeFor(type, id) };
}

export function record(type, id, label) {
  return { type, id: String(id), label: String(label ?? ""), route: routeFor(type, id) };
}

export function evidence(kind, label, value, src = null) {
  return {
    kind: EVIDENCE_KINDS.includes(kind) ? kind : "interpretation",
    label: String(label),
    value: value === null || value === undefined ? null : typeof value === "string" ? value : formatValue(value),
    source: src,
  };
}

export const fact = (label, value, src) => evidence("fact", label, value, src);
export const calculation = (label, value, src) => evidence("calculation", label, value, src);
export const interpretation = (label, value, src) => evidence("interpretation", label, value, src);
export const estimate = (label, value, src) => evidence("estimate", label, value, src);
export const missing = (label, value, src) => evidence("missing", label, value, src);

export function formatValue(value) {
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(formatValue).join(", ");
  return JSON.stringify(value);
}

export function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return "unknown";
  const rounded = Math.round(value * 10 ** digits) / 10 ** digits;
  return String(rounded);
}

// Money in tool summaries and evidence uses the canonical "3.900 kr" format
// (atlas-domain formatKr, the port of AtlasFormat.money) so Atlas AI answers
// read exactly like every page. Unknown stays "unknown", never 0 kr.
export function formatIsk(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return formatKr(value, "unknown");
}
export { formatKr };

export function quantityLabel(quantity, unit) {
  if (quantity === null || quantity === undefined || !Number.isFinite(Number(quantity))) return "unknown";
  return `${formatNumber(Number(quantity))} ${unit || "units"}`;
}

export function truncate(list, limit) {
  const rows = Array.isArray(list) ? list : [];
  return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
}
