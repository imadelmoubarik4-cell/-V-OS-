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

// Hash routes the Atlas web shell understands (`#<view>?…`). The shell
// selects the view from the part before `?`; the Atlas AI workspace reads the
// query to open the record.
const ROUTES = {
  inventory_item: (id) => `#inventory?item=${enc(id)}`,
  inventory: () => "#inventory",
  stock_count: (id) => (id ? `#inventory?section=stock-count&count=${enc(id)}` : "#inventory?section=stock-count"),
  par_levels: (id) => (id ? `#inventory?section=par-levels&item=${enc(id)}` : "#inventory?section=par-levels"),
  data_review: (id) => (id ? `#inventory?section=item-master&issue=${enc(id)}` : "#inventory?section=item-master"),
  movement: (id) => `#movements?movement=${enc(id)}`,
  waste: () => "#waste",
  recipe: (id) => `#recipes?recipe=${enc(id)}`,
  recipes: () => "#recipes",
  supplier: (id) => `#suppliers?supplier=${enc(id)}`,
  purchase_order: (id) => (id ? `#suppliers?purchase_order=${enc(id)}` : "#suppliers?section=purchase-orders"),
  report: (id) => `#reports/${enc(id || "overview")}`,
  routine: (id) => `#dashboard?routine=${enc(id)}`,
  operations: () => "#dashboard",
  shift_week: (id) => `#shifts?week=${enc(id)}`,
  shift: (id) => `#shifts?shift=${enc(id)}`,
  profile: (id) => `#team?profile=${enc(id)}`,
  // Messages live at #messages; #team is the Team directory (S88 route table).
  team_channel: (id) => `#messages?channel=${enc(id)}`,
  knowledge_article: (id) => `#knowledge?article=${enc(id)}`,
  knowledge: () => "#knowledge",
  settings: (id) => (id ? `#settings?tab=${enc(id)}` : "#settings"),
  brain_recommendation: (id) => `#dashboard?recommendation=${enc(id)}`,
  brain_memory: () => "#dashboard?section=brain",
  marketing_recommendation: (id) => `#marketing?recommendation=${enc(id)}`,
  marketing: () => "#marketing",
  integration: (id) => (id ? `#settings?tab=integrations&provider=${enc(id)}` : "#settings?tab=integrations"),
  venue_clock: () => "#settings?tab=hours",
  home: () => "#dashboard",
};

function enc(value) {
  return encodeURIComponent(String(value ?? ""));
}

// Screen roots used when a route is asked for without a record id.
const ROOTS = {
  inventory_item: "#inventory", movement: "#movements", recipe: "#recipes", supplier: "#suppliers",
  report: "#reports/overview", routine: "#dashboard", shift_week: "#shifts", shift: "#shifts", profile: "#team",
  team_channel: "#messages", knowledge_article: "#knowledge", brain_recommendation: "#dashboard",
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

export function formatIsk(value) {
  if (!Number.isFinite(value)) return "unknown";
  return `${Math.round(value).toLocaleString("en-US")} ISK`;
}

export function quantityLabel(quantity, unit) {
  if (quantity === null || quantity === undefined || !Number.isFinite(Number(quantity))) return "unknown";
  return `${formatNumber(Number(quantity))} ${unit || "units"}`;
}

export function truncate(list, limit) {
  const rows = Array.isArray(list) ? list : [];
  return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit };
}
