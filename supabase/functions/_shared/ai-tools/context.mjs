// Structured conversation context (ai_conversations.context) and follow-up
// resolution.
//
// After each tool call the runtime merges `buildContextPatch(...)` into the
// conversation context (atlas_ai_conversation_context_merge). Follow-ups such
// as "What about tomorrow?", "Only wines", "Prepare that", "Why?" and
// "Change it to three cases" resolve against it with `resolveFollowUp`, which
// returns the tool call to make (name + args) instead of letting the model
// guess. The instructions include `contextSummaryForPrompt(context)`.

import { addDays } from "./helpers.mjs";

const MAX_RECORDS = 10;

function pickDate(data) {
  if (!data || typeof data !== "object") return null;
  for (const key of ["date", "business_date", "week_start"]) {
    if (typeof data[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(data[key])) return data[key];
  }
  return null;
}

// Shallow patch for ai_conversations.context after a tool result. Keys:
// last_tool, last_args, last_records, last_subject, date_focus, filters,
// last_proposal, last_summary, last_evidence. `args` (the validated tool
// arguments) is optional but lets follow-ups re-run the same question.
export function buildContextPatch(toolName, toolResult, prevContext = {}, args = null) {
  const previous = prevContext && typeof prevContext === "object" ? prevContext : {};
  if (!toolResult || toolResult.ok !== true) {
    return { last_tool: toolName, last_error: toolResult?.error?.code ?? "unavailable" };
  }
  const patch = {
    last_tool: toolName,
    last_args: args && typeof args === "object" ? args : null,
    last_summary: String(toolResult.summary || "").slice(0, 500),
    last_evidence: (toolResult.evidence || []).slice(0, 8).map((entry) => ({ kind: entry.kind, label: entry.label, value: entry.value })),
    last_error: null,
  };
  const records = (toolResult.records || []).slice(0, MAX_RECORDS).map((entry) => ({ type: entry.type, id: entry.id, label: entry.label, route: entry.route ?? null }));
  if (records.length) {
    patch.last_records = records;
    patch.last_subject = records[0];
  }
  const date = pickDate(toolResult.data) || (args && typeof args.date === "string" ? args.date : null);
  if (date) patch.date_focus = date;
  const category = args?.category ?? toolResult.data?.category ?? null;
  if (category) patch.filters = { ...(previous.filters || {}), category };
  else if (args && Object.hasOwn(args, "category") && args.category === null && previous.filters?.category) {
    patch.filters = { ...(previous.filters || {}), category: null };
  }
  if (toolResult.proposal) {
    patch.last_proposal = {
      kind: toolResult.proposal.kind,
      title: toolResult.proposal.title,
      tool: toolName,
      args: args ?? null,
      lines: Array.isArray(toolResult.data?.lines)
        ? toolResult.data.lines.map((line) => ({ item_id: line.item_id, name: line.name, quantity: line.quantity, units_per_case: line.units_per_case ?? null, unit: line.unit ?? null }))
        : Array.isArray(toolResult.data?.entries)
          ? toolResult.data.entries.map((entry) => ({ item_id: entry.item_id, name: entry.item_name, quantity: entry.quantity, unit: entry.unit }))
          : null,
    };
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

const NUMBER_WORDS = {
  zero: 0, one: 1, a: 1, an: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, dozen: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, half: 0.5,
};

export function parseQuantity(text) {
  const value = String(text ?? "").toLowerCase();
  const digits = value.match(/(\d+(?:[.,]\d+)?)/);
  if (digits) return Number(digits[1].replace(",", "."));
  for (const word of value.split(/[^a-z]+/)) {
    if (Object.hasOwn(NUMBER_WORDS, word) && !["a", "an"].includes(word)) return NUMBER_WORDS[word];
  }
  return null;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// "tomorrow", "yesterday", "day after tomorrow", "friday", "next monday",
// "today" → ISO date relative to the venue business date.
export function resolveDateReference(text, { businessDate, dateFocus = null } = {}) {
  const value = String(text ?? "").toLowerCase();
  if (!businessDate) return null;
  if (/day after tomorrow/.test(value)) return addDays(businessDate, 2);
  if (/\btomorrow\b/.test(value)) return addDays(businessDate, 1);
  if (/\byesterday\b/.test(value)) return addDays(businessDate, -1);
  if (/\b(today|tonight)\b/.test(value)) return businessDate;
  const iso = value.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const weekday = WEEKDAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(value));
  if (weekday >= 0) {
    const base = new Date(`${businessDate}T12:00:00Z`).getUTCDay();
    let offset = (weekday - base + 7) % 7;
    if (offset === 0 || /\bnext\b/.test(value)) offset = offset === 0 ? 7 : offset;
    return addDays(businessDate, offset);
  }
  if (/\b(the )?same day\b/.test(value) && dateFocus) return dateFocus;
  return null;
}

const CATEGORY_WORDS = [
  [/\bwines?\b|\bvín\b/, "Wine"],
  [/\bbeers?\b|\bbjór\b/, "Beer"],
  [/\bspirits?\b|\bliquors?\b/, "Spirits"],
  [/\bmixers?\b/, "Mixers"],
  [/\bsoft drinks?\b|\bsodas?\b/, "Soft drinks"],
  [/\bfood\b|\bkitchen\b/, "Food"],
  [/\bsyrups?\b/, "Syrups"],
];

// "Only wines" / "just the beer" → { category } (null when nothing matched;
// "all categories" clears the filter).
export function resolveFilterReference(text) {
  const value = String(text ?? "").toLowerCase();
  if (/\b(all|every) (categories|items|of them)\b|\bclear (the )?filter\b/.test(value)) return { category: null };
  for (const [pattern, category] of CATEGORY_WORDS) if (pattern.test(value)) return { category };
  return null;
}

// Tools that can be re-run with a date or category.
const DATE_TOOLS = { "shifts.who_is_working": "date", "operations.status": "date", "shifts.schedule": "week_start", "marketing.suggestions": "date" };
const FILTER_TOOLS = new Set(["inventory.below_par", "inventory.current_stock", "inventory.stale_counts", "inventory.search", "reports.inventory_value"]);
// "Prepare that" after a read tool → the draft tool that acts on it.
const PREPARE_FROM = {
  "purchasing.suggest": (context) => {
    const supplierId = context.last_args?.supplier_id ?? null;
    return { tool: "purchasing.prepare_draft_po", args: { supplier_id: supplierId, supplier_query: null, use_suggestions: true, lines: null, note: null, expected_delivery_date: null }, needs: supplierId ? [] : ["supplier"] };
  },
  "data_quality.par_suggestions": (context) => ({ tool: "data_quality.par_suggestions", args: { ...(context.last_args || { item_ids: null, limit: null }), cover_days: context.last_args?.cover_days ?? null }, needs: context.last_args?.cover_days ? [] : ["cover_days"] }),
  "settings.read": () => ({ tool: "settings.suggest_change", args: null, needs: ["change"] }),
};

function withArg(args, key, value) {
  return { ...(args || {}), [key]: value };
}

// Changes the last proposal's quantities: "change it to three cases",
// "make the Campari four", "change Tanqueray to 8 bottles". Returns
// { tool, args } to re-run the draft tool, or { needs } when unclear.
export function modifyProposalArgs(lastProposal, text) {
  if (!lastProposal?.tool || !lastProposal.args) return { needs: ["proposal"] };
  const value = String(text ?? "").toLowerCase();
  const quantity = parseQuantity(value);
  if (quantity === null) return { needs: ["quantity"] };
  const lines = Array.isArray(lastProposal.lines) ? lastProposal.lines : [];
  let target = lines.length === 1 ? lines[0] : lines.find((line) => line.name && value.includes(String(line.name).toLowerCase().split(/\s+/)[0]));
  if (!target) return { needs: ["which_line"], candidates: lines.map((line) => line.name) };
  const cases = /\bcases?\b/.test(value);
  if (lastProposal.tool === "purchasing.prepare_draft_po") {
    if (cases && !(Number(target.units_per_case) > 1)) return { needs: ["units_per_case"], line: target.name };
    const newQuantity = cases ? quantity * Number(target.units_per_case) : quantity;
    const source = Array.isArray(lastProposal.args.lines) && lastProposal.args.lines.length
      ? lastProposal.args.lines
      : lines.map((line) => ({ item_id: line.item_id, item_query: null, quantity: line.quantity, unit_cost: null }));
    // Lines drafted by name (item_query) have no item_id yet; the proposal's
    // resolved lines are in the same order, so match those by position.
    const nextLines = source.map((line, index) => ((line.item_id ? line.item_id === target.item_id : lines[index]?.item_id === target.item_id)
      ? { ...line, item_id: target.item_id, item_query: null, quantity: newQuantity }
      : line));
    return { tool: lastProposal.tool, args: { ...lastProposal.args, use_suggestions: false, lines: nextLines } };
  }
  if (lastProposal.tool === "inventory.prepare_count") {
    const unit = cases ? "case" : /\bbottles?\b/.test(value) ? "bottle" : null;
    const nextEntries = (lastProposal.args.entries || []).map((entry, index) => {
      const matches = entry.item_id ? entry.item_id === target.item_id : lines[index]?.item_id === target.item_id;
      return matches ? { ...entry, quantity, unit: unit ?? entry.unit } : entry;
    });
    return { tool: lastProposal.tool, args: { ...lastProposal.args, entries: nextEntries } };
  }
  return { needs: ["unsupported"] };
}

// Classifies a short follow-up and returns the tool call it implies.
// Result: { kind: 'date'|'filter'|'prepare'|'why'|'modify_proposal'|null,
//           tool?, args?, needs?, evidence? }
export function resolveFollowUp(text, context = {}, { businessDate = null } = {}) {
  const value = String(text ?? "").trim().toLowerCase();
  const ctx = context && typeof context === "object" ? context : {};
  if (!value) return { kind: null };
  if (/^(why|how (do|did) you know|where does that come from|explain)\b/.test(value)) {
    return { kind: "why", evidence: ctx.last_evidence || [], summary: ctx.last_summary || null };
  }
  if (/\b(change|make|set|update)\b.*\b(it|that|them|to)\b/.test(value) && ctx.last_proposal) {
    return { kind: "modify_proposal", ...modifyProposalArgs(ctx.last_proposal, value) };
  }
  if (/^(ok(ay)?,? )?(prepare|draft|do|set up|create) (that|it|this|them|the order)\b/.test(value)) {
    const builder = PREPARE_FROM[ctx.last_tool];
    if (!builder) return { kind: "prepare", needs: ["what_to_prepare"] };
    return { kind: "prepare", ...builder(ctx) };
  }
  const date = resolveDateReference(value, { businessDate, dateFocus: ctx.date_focus });
  if (date && /^(what|and|how) about|^(and )?(for )?(tomorrow|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(value)) {
    const key = DATE_TOOLS[ctx.last_tool];
    if (key) {
      const args = ctx.last_tool === "shifts.who_is_working" ? { ...(ctx.last_args || {}), day: null, date } : withArg(ctx.last_args, key, date);
      return { kind: "date", date, tool: ctx.last_tool, args };
    }
    return { kind: "date", date, needs: ["tool"] };
  }
  const filter = resolveFilterReference(value);
  if (filter && /^(only|just|and|what about|show|now)\b/.test(value)) {
    if (FILTER_TOOLS.has(ctx.last_tool)) return { kind: "filter", filters: filter, tool: ctx.last_tool, args: withArg(ctx.last_args, "category", filter.category) };
    return { kind: "filter", filters: filter, needs: ["tool"] };
  }
  return { kind: null };
}

// Compact, model-facing summary of the structured context.
export function contextSummaryForPrompt(context = {}) {
  const ctx = context && typeof context === "object" ? context : {};
  const parts = [];
  if (ctx.last_subject) parts.push(`Last record: ${ctx.last_subject.type} "${ctx.last_subject.label}" (${ctx.last_subject.id}).`);
  if (Array.isArray(ctx.last_records) && ctx.last_records.length > 1) {
    parts.push(`Recent records: ${ctx.last_records.slice(0, 6).map((entry) => `${entry.label} [${entry.type}:${entry.id}]`).join("; ")}.`);
  }
  if (ctx.date_focus) parts.push(`Date in focus: ${ctx.date_focus}.`);
  if (ctx.filters?.category) parts.push(`Active filter: category = ${ctx.filters.category}.`);
  if (ctx.last_tool) parts.push(`Last lookup: ${ctx.last_tool}.`);
  if (ctx.last_proposal) parts.push(`Last proposal (not executed unless approved): ${ctx.last_proposal.kind} "${ctx.last_proposal.title}".`);
  return parts.join(" ");
}
