// Settings (read only), decision memory, data quality, marketing,
// integrations and navigation tools.

import { S } from "./schema.mjs";
import { buildProposal } from "./actions.mjs";
import { calculation, fact, formatNumber, interpretation, missing, ok, record, routeFor, source, ToolError, truncate } from "./result.mjs";
import { clampLimit, isManagerActor, text, venueDates } from "./helpers.mjs";

const ALL = ["admin", "manager", "bartender", "viewer"];
const MANAGERS = ["admin", "manager"];

export const DATA_REVIEW_ISSUES = Object.freeze([
  "inventory.missing_supplier", "inventory.supplier_text_unlinked", "inventory.missing_cost", "inventory.missing_reference",
  "inventory.package_missing", "inventory.package_unreadable", "inventory.missing_par", "inventory.flagged_needs_review",
  "recipe.missing_price", "recipe.no_ingredients", "recipe.ingredient_unlinked", "recipe.ingredient_inactive_item",
]);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const settingsRead = {
  name: "settings.read",
  level: "read",
  roles: ALL,
  specialist: "operations",
  progress: "Checking settings",
  description: "Read-only venue settings: time zone, current business date and local time, opening hours per weekday and offers such as happy hour. If opening hours are not configured, say they are not set — never assume hours. section 'all' (managers only) adds the other Settings sections. Atlas cannot change settings.",
  parameters: S.object({ section: S.nullable(S.enum(["venue_clock", "hours", "offers", "all"], "What to read (default venue_clock)")) }),
  async execute(args, ctx) {
    const section = args.section || "venue_clock";
    if (section === "all" && !isManagerActor(ctx.actor)) throw new ToolError("forbidden", "Only managers can read all Settings sections.");
    const clock = await ctx.services.venueClock();
    if (!clock) throw new ToolError("unavailable", "The venue clock is unavailable right now.");
    const hours = (clock.business_hours || []).map((entry) => ({
      weekday: WEEKDAYS[Number(entry.weekday)] || String(entry.weekday),
      is_open: entry.is_open === true,
      open_time: entry.open_time ? String(entry.open_time).slice(0, 5) : null,
      close_time: entry.close_time ? String(entry.close_time).slice(0, 5) : null,
      close_next_day: entry.close_next_day === true,
      last_order_time: entry.last_order_time ? String(entry.last_order_time).slice(0, 5) : null,
      kitchen_close_time: entry.kitchen_close_time ? String(entry.kitchen_close_time).slice(0, 5) : null,
    }));
    const offers = (clock.offers || []).map((offer) => ({ name: offer.name, days: offer.days, start_time: offer.start_time, end_time: offer.end_time }));
    const src = source("venue_clock", null, "Opening hours");
    const evidence = [
      fact("Time zone", `${clock.timezone}${clock.timezone_source === "default" ? " (default; not set in Settings)" : ""}`, src),
      fact("Business date", clock.business_date, src),
      fact("Venue local time", String(clock.venue_local_time || "").replace("T", " "), src),
      clock.hours_configured ? fact("Opening hours", `${hours.filter((entry) => entry.is_open).length} open days configured`, src) : missing("Opening hours", "not set in Settings", src),
      offers.length ? fact("Offers", offers.map((offer) => offer.name).join(", "), src) : missing("Offers", "none configured", src),
    ];
    const data = {
      timezone: clock.timezone,
      business_date: clock.business_date,
      venue_date: clock.venue_date,
      venue_local_time: clock.venue_local_time,
      hours_configured: clock.hours_configured === true,
      business_hours: section === "offers" ? undefined : clock.hours_configured ? hours : [],
      offers: section === "hours" ? undefined : offers,
    };
    if (section === "all") {
      const snapshot = await ctx.services.settingsSnapshot();
      const sections = snapshot?.workspace?.sections ?? snapshot?.settings?.sections ?? null;
      data.sections = Array.isArray(sections)
        ? sections.map((entry) => ({ key: entry.section_key ?? entry.key ?? null, values: entry.settings_value ?? entry.value ?? null }))
        : sections;
    }
    return ok({
      summary: `${clock.business_date} in ${clock.timezone}. ${clock.hours_configured ? "Opening hours are set." : "Opening hours are not set in Settings."} ${offers.length ? `${offers.length} offers configured.` : "No offers configured."}`,
      data,
      evidence,
      records: [record("settings", "hours", "Opening hours")],
      unknown: clock.hours_configured ? null : { count: 1, reason: "Opening hours are not set" },
    });
  },
};

const suggestSettings = {
  name: "settings.suggest_change",
  level: "draft",
  roles: MANAGERS,
  specialist: "operations",
  progress: "Preparing a settings suggestion",
  description: "Manager only. Suggest a Settings change (e.g. set opening hours). Atlas never writes settings: the result is a suggestion card that opens the right Settings tab for the manager to make the change.",
  parameters: S.object({
    section: S.enum(["venue", "hours", "offers", "notifications", "roles", "preferences", "integrations", "other"], "Settings area"),
    change: S.string("The suggested change in plain words", { maxLength: 1000 }),
    reason: S.nullable(S.string("Why", { maxLength: 1000 })),
  }),
  async execute(args) {
    const command = { section: args.section, change: args.change, reason: args.reason ?? null };
    const proposal = buildProposal("settings.suggestion", command, { title: `Settings suggestion: ${args.section}`, subjectKey: args.section });
    return ok({
      summary: `Suggestion ready: open Settings (${args.section}) to make the change. Atlas does not change settings.`,
      data: { suggestion: command, route: routeFor("settings", args.section) },
      evidence: [interpretation("Suggested change", args.change, source("settings", args.section, "Settings"))],
      records: [record("settings", args.section, "Settings")],
      proposal,
    });
  },
};

// ---------------------------------------------------------------------------
// Decision memory
// ---------------------------------------------------------------------------

const history = {
  name: "decisions.history",
  level: "read",
  roles: MANAGERS,
  specialist: "operations",
  progress: "Checking past decisions",
  description: "Manager only. Past decisions from the Atlas decision memory (accepted/rejected/deferred recommendations and approvals, with reasons), by free-text query or by exact subject (subject_type + subject_key, e.g. inventory_item + id). Use to say things like 'last time you deferred this because a delivery was expected'.",
  parameters: S.object({
    query: S.nullable(S.string("Free-text search", { maxLength: 200 })),
    subject_type: S.nullable(S.string("Exact subject type, e.g. inventory_item", { maxLength: 80 })),
    subject_key: S.nullable(S.string("Exact subject key (id)", { maxLength: 200 })),
    limit: S.nullable(S.integer("Maximum entries (default 10)", { minimum: 1, maximum: 50 })),
  }),
  async execute(args, ctx) {
    const limit = clampLimit(args.limit, 10, 50);
    let rows;
    if (args.subject_type && args.subject_key) rows = await ctx.services.phase3Memory(args.subject_type, args.subject_key, limit);
    else if (args.query) rows = await ctx.services.memorySearch(args.query, limit);
    else throw new ToolError("invalid_arguments", "Give a query, or subject_type and subject_key.");
    const list = (Array.isArray(rows) ? rows : Array.isArray(rows?.memory) ? rows.memory : []).slice(0, limit).map((row) => ({
      id: row.memory_id ?? row.id ?? null,
      type: row.memory_type ?? null,
      subject_type: row.subject_type ?? null,
      subject_key: row.subject_key ?? null,
      action: row.action ?? null,
      title: row.title ?? null,
      summary: row.summary ?? null,
      reason: row.context?.reason_code ?? row.context?.notes ?? null,
      notes: row.context?.notes ?? null,
      by: row.actor_label ?? null,
      at: row.occurred_at ?? null,
    }));
    return ok({
      summary: list.length ? `${list.length} past decisions found; latest: ${list[0].action || "decision"} on "${list[0].title || list[0].subject_key}" (${text(list[0].at).slice(0, 10)}).` : "No past decisions found.",
      data: { decisions: list },
      evidence: list.map((row) => fact(`${row.action || "Decision"}: ${row.title || row.subject_key}`, `${row.by || "someone"} on ${text(row.at).slice(0, 10)}${row.reason ? ` — ${row.reason}` : ""}`, source("brain_memory", row.id, row.title))),
      records: [],
    });
  },
};

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

const reviewList = {
  name: "data_quality.review_list",
  level: "read",
  roles: MANAGERS,
  specialist: "data_quality",
  progress: "Reviewing data to fix",
  description: "Manager only. Data that needs fixing, from the Data review queues: items missing supplier, cost, package size or par level, unreadable package text, recipes without price or with unlinked/inactive ingredients. Without issue: counts per issue. With issue: the affected records and where to fix them.",
  parameters: S.object({
    issue: S.nullable(S.enum(DATA_REVIEW_ISSUES, "One issue code to list")),
    limit: S.nullable(S.integer("Maximum rows (default 20)", { minimum: 1, maximum: 50 })),
    offset: S.nullable(S.integer("Rows to skip", { minimum: 0, maximum: 10000 })),
  }),
  async execute(args, ctx) {
    if (!args.issue) {
      const summary = await ctx.services.dataReviewSummary();
      const issues = (summary?.issues || []).map((issue) => ({ code: issue.code, label: issue.label, entity_type: issue.entity_type, count: Number(issue.count) || 0 }))
        .sort((a, b) => b.count - a.count);
      const open = issues.filter((issue) => issue.count > 0);
      return ok({
        summary: open.length ? `${open.length} kinds of data need attention; largest: ${open[0].label} (${open[0].count}).` : "No data issues found.",
        data: { issues, generated_at: summary?.generated_at ?? null },
        evidence: open.map((issue) => fact(issue.label, String(issue.count), source("data_review", issue.code, issue.label))),
        records: [],
      });
    }
    const limit = clampLimit(args.limit, 20, 50);
    const result = await ctx.services.dataReviewRows(args.issue, limit, args.offset ?? 0);
    const rows = (result?.rows || []).map((row) => ({ entity_type: row.entity_type, id: row.entity_id, name: row.name, category: row.category ?? null, detail: row.detail ?? null, fix: row.fix ?? null }));
    return ok({
      summary: `${result?.total ?? rows.length} records: ${result?.label || args.issue}.`,
      data: { issue: args.issue, label: result?.label ?? null, total: result?.total ?? rows.length, rows },
      evidence: rows.slice(0, 20).map((row) => fact(row.name, row.detail || result?.label || args.issue, source(row.entity_type === "recipe" ? "recipe" : "inventory_item", row.id, row.name))),
      records: rows.map((row) => record(row.entity_type === "recipe" ? "recipe" : "inventory_item", row.id, row.name)),
    });
  },
};

const parSuggestions = {
  name: "data_quality.par_suggestions",
  level: "draft",
  roles: MANAGERS,
  specialist: "data_quality",
  progress: "Looking at par level evidence",
  description: "Manager only. Evidence for setting par levels from recorded usage (needs at least 3 observations over 14+ days in the last 120 days). With cover_days (how many days of stock to hold) it returns suggested pars for eligible items as a suggestion card that opens the par editor; nothing is saved. Items without enough evidence are listed as unknown — never invent a par.",
  parameters: S.object({
    item_ids: S.nullable(S.array(S.uuid(), "Only these items", { minItems: 1, maxItems: 100 })),
    cover_days: S.nullable(S.number("Days of stock to cover (e.g. 7)", { minimum: 1, maximum: 60 })),
    limit: S.nullable(S.integer("Maximum items listed (default 20)", { minimum: 1, maximum: 100 })),
  }),
  async execute(args, ctx) {
    const result = await ctx.services.parLevelEvidence(args.item_ids ?? null, args.cover_days ?? null);
    const items = Array.isArray(result?.items) ? result.items : [];
    const eligible = items.filter((item) => item.eligible);
    const suggested = eligible.filter((item) => item.suggestion && Number.isFinite(Number(item.suggestion.par_level)));
    const ineligible = items.length - eligible.length;
    const limit = clampLimit(args.limit, 20, 100);
    const view = items.slice(0, limit).map((item) => ({
      item_id: item.item_id, name: item.name, unit: item.unit ?? null, current_par: item.par_level ?? null, eligible: item.eligible === true,
      observations: item.observations ?? null, span_days: item.span_days ?? null, avg_daily_usage: item.avg_daily_usage ?? null,
      reason: item.reason ?? null, suggested_par: item.suggestion?.par_level ?? null, cases: item.suggestion?.cases ?? null,
    }));
    let proposal = null;
    if (args.cover_days && suggested.length) {
      proposal = buildProposal("par_level.suggestion", {
        cover_days: args.cover_days,
        items: suggested.slice(0, 100).map((item) => ({
          item_id: String(item.item_id),
          item_name: String(item.name),
          current_par: item.par_level === null || item.par_level === undefined ? null : Number(item.par_level),
          suggested_par: Number(item.suggestion.par_level),
          cases: item.suggestion.cases === null || item.suggestion.cases === undefined ? null : Number(item.suggestion.cases),
        })),
      }, { title: `Par suggestions (${suggested.length} items, ${formatNumber(args.cover_days)} days cover)` });
    }
    return ok({
      summary: `${eligible.length} of ${items.length} items have enough usage evidence for a par level; ${ineligible} do not.${args.cover_days ? ` ${suggested.length} suggestions for ${formatNumber(args.cover_days)} days of cover — review them in the par editor; nothing is saved.` : " Give cover_days to get suggested pars."}`,
      data: { rule: result?.rule ?? null, items: view, eligible: eligible.length, ineligible, suggested: suggested.length },
      evidence: [
        ...suggested.slice(0, 15).map((item) => calculation(`${item.name} suggested par`, `${formatNumber(Number(item.suggestion.par_level))} (${formatNumber(Number(item.avg_daily_usage))}/day × ${formatNumber(args.cover_days)} days)`, source("par_levels", item.item_id, item.name))),
        ...(ineligible ? [missing("Items without enough usage evidence", `${ineligible} items — no par can be suggested`, source("par_levels", null, "Par levels"))] : []),
      ],
      records: view.map((item) => record("inventory_item", item.item_id, item.name)),
      proposal,
      unknown: ineligible ? { count: ineligible, reason: "Not enough recorded usage to suggest a par level" } : null,
    });
  },
};

// ---------------------------------------------------------------------------
// Marketing, integrations, navigation
// ---------------------------------------------------------------------------

const marketing = {
  name: "marketing.suggestions",
  level: "read",
  roles: ALL,
  specialist: "marketing",
  progress: "Checking marketing ideas",
  description: "Marketing content ideas due or available on a date (default today at the venue). These are seeded recurring templates (e.g. weekly features), not computed from sales or social data — say so.",
  parameters: S.object({ date: S.nullable(S.date("Date YYYY-MM-DD (default today)")) }),
  async execute(args, ctx) {
    const dates = await venueDates(ctx, ctx.services);
    const date = args.date || dates.calendarDate;
    const response = await ctx.services.marketingRecommendations(date);
    const list = Array.isArray(response) ? response : Array.isArray(response?.recommendations) ? response.recommendations : [];
    const rows = list.filter((row) => row.is_due_today || row.available_for_today || !("is_due_today" in row)).map((row) => ({
      id: row.id, title: row.title, summary: row.summary ?? null, content_type: row.content_type ?? null, platforms: row.platforms ?? [],
      suggested_time: row.suggested_time ?? null, due_today: row.is_due_today === true, state: row.occurrence_state ?? row.status ?? null,
      caption_draft: row.caption_draft ?? null,
    }));
    const page = truncate(rows, 10);
    return ok({
      summary: rows.length ? `${rows.length} marketing ideas for ${date} (seeded templates, not data-driven).` : `No marketing ideas scheduled for ${date}.`,
      data: { date, suggestions: page.rows, truncated: page.truncated, basis: "Seeded recurring templates" },
      evidence: [
        ...page.rows.map((row) => fact(row.title, `${row.due_today ? "due today" : "available"}${row.suggested_time ? ` at ${String(row.suggested_time).slice(0, 5)}` : ""}`, source("marketing_recommendation", row.id, row.title))),
        interpretation("Basis", "Seeded templates; sales and social performance are not connected", null),
      ],
      records: page.rows.map((row) => record("marketing_recommendation", row.id, row.title)),
    });
  },
};

const integrations = {
  name: "integrations.status",
  level: "read",
  roles: MANAGERS,
  specialist: "integration",
  progress: "Checking connected services",
  description: "Manager only. The true connection state of each external service (Google Business Profile, Google Drive, Facebook, Instagram, TikTok, Tripadvisor): connected, not configured, needs reauthorisation, etc., and what is missing. Point-of-sale / sales data has no integration and is not connected.",
  parameters: S.object({}),
  async execute(args, ctx) {
    const response = await ctx.services.integrationsStatus();
    const providers = (response?.providers || []).map((provider) => ({
      key: provider.provider_key,
      label: provider.label,
      state: provider.connection_state,
      configured: provider.configured === true,
      account: provider.account_label ?? null,
      last_verified_at: provider.last_verified_at ?? null,
      missing_requirements: provider.missing_requirements || [],
      message: provider.available_message ?? null,
    }));
    const connected = providers.filter((provider) => provider.state === "connected");
    return ok({
      summary: `${connected.length} of ${providers.length} services connected${connected.length ? ` (${connected.map((provider) => provider.label).join(", ")})` : ""}. Point-of-sale / sales data is not connected.`,
      data: { providers, pos: { state: "not_connected", note: "No POS integration exists; sales, covers and realised margin are unavailable." } },
      evidence: [
        ...providers.map((provider) => (provider.state === "connected"
          ? fact(provider.label, `connected${provider.account ? ` (${provider.account})` : ""}`, source("integration", provider.key, provider.label))
          : missing(provider.label, `${String(provider.state || "unknown").replace(/_/g, " ")}${provider.missing_requirements.length ? ` — needs ${provider.missing_requirements.join(", ")}` : ""}`, source("integration", provider.key, provider.label)))),
        missing("Point of sale (sales)", "not connected", source("integration", null, "Integrations")),
      ],
      records: providers.map((provider) => record("integration", provider.key, provider.label)),
    });
  },
};

const OPEN_TARGETS = {
  home: { type: "home", roles: ALL, label: "Home" },
  inventory: { type: "inventory", roles: ALL, label: "Inventory" },
  stock_count: { type: "stock_count", roles: ALL, label: "Stock count" },
  waste: { type: "waste", roles: ALL, label: "Waste" },
  recipes: { type: "recipes", roles: ALL, label: "Recipes" },
  knowledge: { type: "knowledge", roles: ALL, label: "Knowledge" },
  shifts: { type: "shift_week", roles: ALL, label: "Shifts" },
  team: { type: "team_channel", roles: ALL, label: "Team" },
  marketing: { type: "marketing", roles: ALL, label: "Marketing" },
  reports: { type: "report", roles: ALL, label: "Reports" },
  settings: { type: "settings", roles: ALL, label: "Settings" },
  par_levels: { type: "par_levels", roles: MANAGERS, label: "Par levels" },
  data_review: { type: "data_review", roles: MANAGERS, label: "Data review" },
  suppliers: { type: "supplier", roles: MANAGERS, label: "Suppliers" },
  purchase_orders: { type: "purchase_order", roles: MANAGERS, label: "Purchase orders" },
};
const RECORD_TYPES = ["inventory_item", "recipe", "supplier", "purchase_order", "stock_count", "shift_week", "profile", "knowledge_article", "routine", "report", "settings", "data_review", "brain_recommendation"];
const MANAGER_RECORDS = new Set(["supplier", "purchase_order", "data_review", "brain_recommendation"]);

const appOpen = {
  name: "app.open",
  level: "read",
  roles: ALL,
  specialist: "navigation",
  progress: "Opening Atlas",
  description: "Give the user a link to an Atlas screen or record (e.g. open the Margarita recipe or the stock count). Returns a route only; reads no data. Use record ids returned by other tools.",
  parameters: S.object({
    target: S.enum(Object.keys(OPEN_TARGETS), "Screen"),
    record_type: S.nullable(S.enum(RECORD_TYPES, "Record type to open")),
    record_id: S.nullable(S.string("Record id (or report section / settings tab)", { maxLength: 120, pattern: "^[A-Za-z0-9_.:-]+$" })),
    label: S.nullable(S.string("Link label", { maxLength: 120 })),
  }),
  async execute(args, ctx) {
    const target = OPEN_TARGETS[args.target];
    const manager = isManagerActor(ctx.actor);
    if (!target.roles.includes(ctx.actor.role) || (args.record_type && MANAGER_RECORDS.has(args.record_type) && !manager)) {
      throw new ToolError("forbidden", `${target.label} is not available for your Atlas role.`);
    }
    const route = args.record_type && args.record_id ? routeFor(args.record_type, args.record_id) : routeFor(target.type, args.target === "reports" ? "overview" : null);
    const label = args.label || target.label;
    return ok({
      summary: `Link ready: ${label}.`,
      data: { route, label },
      evidence: [],
      records: [{ type: args.record_type || target.type, id: args.record_id || args.target, label, route }],
    });
  },
};

export const ADMIN_TOOLS = [settingsRead, suggestSettings, history, reviewList, parSuggestions, marketing, integrations, appOpen];
